import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { RawData } from "ws";
import { createDecoder, createEncoder } from "libopus-wasm";
import { createLibopusWasmCodecFactory } from "../src/audio/libopus-wasm.js";
import type {
  AudioChunk,
  VoiceEventHandler,
  VoiceProvider,
  VoiceSession,
  VoiceSessionEvent
} from "../src/contracts/providers.js";
import {
  decodeFirmwareAudioFrame,
  encodeFirmwareAudioFrame
} from "../src/device/firmware-wire.js";
import { FirmwareVoiceBridge } from "../src/device/voice-bridge.js";
import { createGatewayServer } from "../src/gateway.js";

type SocketMessage = {
  data: RawData;
  isBinary: boolean;
};

class MessageQueue {
  private readonly queued: SocketMessage[] = [];
  private readonly waiters: Array<(message: SocketMessage) => void> = [];

  constructor(socket: WebSocket) {
    socket.on("message", (data, isBinary) => {
      const message = { data, isBinary };
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(message);
      } else {
        this.queued.push(message);
      }
    });
  }

  async next(): Promise<SocketMessage> {
    const queued = this.queued.shift();
    if (queued) return queued;

    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

class FakeRealtimeVoiceSession implements VoiceSession {
  private readonly handlers = new Set<VoiceEventHandler>();
  readonly input: AudioChunk[] = [];
  readonly firstInput = Promise.withResolvers<AudioChunk>();
  readonly closed = Promise.withResolvers<void>();

  async sendAudio(chunk: AudioChunk): Promise<void> {
    const copied = {
      ...chunk,
      data: chunk.data.slice()
    };
    this.input.push(copied);
    if (this.input.length === 1) {
      this.firstInput.resolve(copied);
    }
  }

  async interrupt(): Promise<void> {}

  subscribe(handler: VoiceEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async close(): Promise<void> {
    this.handlers.clear();
    this.closed.resolve();
  }

  async emit(event: VoiceSessionEvent): Promise<void> {
    for (const handler of [...this.handlers]) {
      await handler(event);
    }
  }
}

class FakeRealtimeVoiceProvider implements VoiceProvider {
  readonly id = "integration-fake";
  readonly session = new FakeRealtimeVoiceSession();

  async connect(): Promise<VoiceSession> {
    return this.session;
  }
}

function makeSinePcm(
  sampleRate: number,
  durationMs: number,
  frequencyHz = 440
): Uint8Array {
  const samples = Math.round((sampleRate * durationMs) / 1000);
  const bytes = new Uint8Array(samples * 2);
  const view = new DataView(bytes.buffer);

  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(
      Math.sin((2 * Math.PI * frequencyHz * index) / sampleRate) * 12000
    );
    view.setInt16(index * 2, value, true);
  }

  return bytes;
}

function pcmEnergy(data: Uint8Array): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let energy = 0;

  for (let offset = 0; offset < data.byteLength; offset += 2) {
    energy += Math.abs(view.getInt16(offset, true));
  }

  return energy;
}

describe("firmware realtime voice vertical slice", () => {
  it("round-trips real Opus through gateway codec and a provider-neutral voice session", async () => {
    const voiceProvider = new FakeRealtimeVoiceProvider();
    const bridge = new FirmwareVoiceBridge({
      voiceProvider,
      codecFactory: createLibopusWasmCodecFactory(),
      prebufferPackets: 5
    });
    const gateway = createGatewayServer({
      firmwareSessionFactory: bridge.createSession
    });

    await new Promise<void>((resolve) =>
      gateway.server.listen(0, "127.0.0.1", resolve)
    );

    const address = gateway.server.address() as AddressInfo;
    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/device`
    );
    const messages = new MessageQueue(socket);
    const uplinkEncoder = await createEncoder({
      sampleRate: 16000,
      channels: 1,
      frameSize: 960
    });
    const downlinkDecoder = await createDecoder({
      sampleRate: 24000,
      channels: 1,
      maxFrameSize: 2880
    });

    try {
      await once(socket, "open");

      socket.send(
        JSON.stringify({
          type: "hello",
          version: 2,
          transport: "websocket",
          audio_params: {
            format: "opus",
            sample_rate: 16000,
            channels: 1,
            frame_duration: 60
          }
        })
      );

      const hello = await messages.next();
      expect(hello.isBinary).toBe(false);
      const serverHello = JSON.parse(hello.data.toString());
      expect(serverHello).toMatchObject({
        type: "hello",
        transport: "websocket",
        audio_params: {
          format: "opus",
          sample_rate: 24000,
          channels: 1,
          frame_duration: 60
        }
      });

      const uplinkPcm = makeSinePcm(16000, 60);
      // Prime the source encoder because the first Opus packet contains normal
      // algorithmic lookahead and is a weaker signal for this integration test.
      for (let index = 0; index < 3; index += 1) {
        uplinkEncoder.encode(uplinkPcm);
      }
      const uplinkOpus = uplinkEncoder.encode(uplinkPcm);

      socket.send(
        Buffer.from(
          encodeFirmwareAudioFrame(
            uplinkOpus,
            2,
            0x10203040
          )
        ),
        { binary: true }
      );

      const providerInput = await voiceProvider.session.firstInput.promise;
      expect(providerInput.format).toBe("pcm16le");
      expect(providerInput.sampleRate).toBe(16000);
      expect(providerInput.channels).toBe(1);
      expect(providerInput.data.byteLength).toBe(1920);
      expect(pcmEnergy(providerInput.data)).toBeGreaterThan(10000);

      // 80 ms deliberately leaves a 20 ms tail. The codec must emit one normal
      // 60 ms packet and one zero-padded final packet when the provider turn
      // completes, rather than dropping the audible tail.
      await voiceProvider.session.emit({
        type: "audio",
        chunk: {
          format: "pcm16le",
          data: makeSinePcm(24000, 80, 660),
          sampleRate: 24000,
          channels: 1
        }
      });
      await voiceProvider.session.emit({
        type: "output.completed"
      });

      const start = await messages.next();
      expect(start.isBinary).toBe(false);
      expect(JSON.parse(start.data.toString())).toEqual({
        type: "tts",
        state: "start",
        session_id: serverHello.session_id
      });

      const audio1 = await messages.next();
      const audio2 = await messages.next();
      expect(audio1.isBinary).toBe(true);
      expect(audio2.isBinary).toBe(true);

      const frame1 = decodeFirmwareAudioFrame(
        new Uint8Array(audio1.data as Buffer),
        2
      );
      const frame2 = decodeFirmwareAudioFrame(
        new Uint8Array(audio2.data as Buffer),
        2
      );

      expect(frame2.timestamp - frame1.timestamp).toBe(60);
      expect(frame1.payload.byteLength).toBeGreaterThan(0);
      expect(frame2.payload.byteLength).toBeGreaterThan(0);

      const decoded1 = downlinkDecoder.decode(frame1.payload);
      const decoded2 = downlinkDecoder.decode(frame2.payload);
      expect(decoded1.length).toBe(1440);
      expect(decoded2.length).toBe(1440);

      const stop = await messages.next();
      expect(stop.isBinary).toBe(false);
      expect(JSON.parse(stop.data.toString())).toEqual({
        type: "tts",
        state: "stop",
        session_id: serverHello.session_id
      });

      const closed = once(socket, "close");
      socket.close();
      await closed;
      await voiceProvider.session.closed.promise;
    } finally {
      uplinkEncoder.free();
      downlinkDecoder.free();

      if (socket.readyState === WebSocket.OPEN) {
        const closed = once(socket, "close");
        socket.close();
        await closed;
      } else if (socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }

      await new Promise<void>((resolve) =>
        gateway.wss.close(() => resolve())
      );
      await new Promise<void>((resolve, reject) =>
        gateway.server.close((error) =>
          error ? reject(error) : resolve()
        )
      );
    }
  });
});
