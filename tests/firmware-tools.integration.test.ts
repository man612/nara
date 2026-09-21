import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { RawData } from "ws";
import type {
  AudioCodecFactory,
  AudioCodecSession,
  AudioCodecSessionConfig
} from "../src/audio/codec.js";
import type { ToolResult } from "../src/actions/contracts.js";
import type {
  AudioChunk,
  VoiceConnectOptions,
  VoiceEventHandler,
  VoiceProvider,
  VoiceSession,
  VoiceSessionEvent
} from "../src/contracts/providers.js";
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
      if (waiter) waiter(message);
      else this.queued.push(message);
    });
  }

  async nextJson(): Promise<Record<string, unknown>> {
    const message =
      this.queued.shift() ??
      (await new Promise<SocketMessage>((resolve) => {
        this.waiters.push(resolve);
      }));
    expect(message.isBinary).toBe(false);
    return JSON.parse(message.data.toString()) as Record<string, unknown>;
  }
}

class NoopCodecSession implements AudioCodecSession {
  async decodeUplink(_packet: Uint8Array): Promise<AudioChunk> {
    return {
      format: "pcm16le",
      data: new Uint8Array(2),
      sampleRate: 16000,
      channels: 1
    };
  }
  async encodeDownlink(): Promise<Uint8Array[]> {
    return [];
  }
  async flushDownlink(): Promise<Uint8Array[]> {
    return [];
  }
  async resetDownlink(): Promise<void> {}
  async close(): Promise<void> {}
}

class NoopCodecFactory implements AudioCodecFactory {
  async createSession(
    _config: AudioCodecSessionConfig
  ): Promise<AudioCodecSession> {
    return new NoopCodecSession();
  }
}

class FakeVoiceSession implements VoiceSession {
  private readonly handlers = new Set<VoiceEventHandler>();
  readonly toolResults: ToolResult[] = [];
  readonly firstToolResult: Promise<ToolResult>;
  private resolveToolResult!: (result: ToolResult) => void;

  constructor() {
    this.firstToolResult = new Promise((resolve) => {
      this.resolveToolResult = resolve;
    });
  }

  async sendAudio(): Promise<void> {}
  async interrupt(): Promise<void> {}

  async sendToolResult(result: ToolResult): Promise<void> {
    this.toolResults.push(result);
    if (this.toolResults.length === 1) {
      this.resolveToolResult(result);
    }
  }

  subscribe(handler: VoiceEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async close(): Promise<void> {
    this.handlers.clear();
  }

  async emit(event: VoiceSessionEvent): Promise<void> {
    for (const handler of [...this.handlers]) {
      await handler(event);
    }
  }
}

class FakeVoiceProvider implements VoiceProvider {
  readonly id = "tool-integration";
  readonly session = new FakeVoiceSession();
  tools: VoiceConnectOptions["tools"];
  readonly connected: Promise<void>;
  private resolveConnected!: () => void;

  constructor() {
    this.connected = new Promise((resolve) => {
      this.resolveConnected = resolve;
    });
  }

  async connect(options?: VoiceConnectOptions): Promise<VoiceSession> {
    this.tools = options?.tools;
    this.resolveConnected();
    return this.session;
  }
}

function mcpPayload(message: Record<string, unknown>): Record<string, unknown> {
  expect(message.type).toBe("mcp");
  return message.payload as Record<string, unknown>;
}

describe("firmware action vertical slice", () => {
  it("executes a voice volume tool through legacy device MCP and returns the result", async () => {
    const voiceProvider = new FakeVoiceProvider();
    const bridge = new FirmwareVoiceBridge({
      voiceProvider,
      codecFactory: new NoopCodecFactory()
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

    try {
      await once(socket, "open");
      socket.send(
        JSON.stringify({
          type: "hello",
          version: 2,
          transport: "websocket",
          features: { mcp: true },
          audio_params: {
            format: "opus",
            sample_rate: 16000,
            channels: 1,
            frame_duration: 60
          }
        })
      );

      const hello = await messages.nextJson();
      expect(hello.type).toBe("hello");
      await voiceProvider.connected;
      expect(voiceProvider.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "device_set_volume",
            effect: "write"
          })
        ])
      );

      await voiceProvider.session.emit({
        type: "tool.call",
        name: "device_set_volume",
        arguments: { volume: 30 },
        callId: "call-volume"
      });

      const initialize = mcpPayload(await messages.nextJson());
      expect(initialize).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize"
      });
      socket.send(
        JSON.stringify({
          type: "mcp",
          payload: {
            jsonrpc: "2.0",
            id: 1,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "fake-esp32", version: "test" }
            }
          }
        })
      );

      expect(mcpPayload(await messages.nextJson())).toEqual({
        jsonrpc: "2.0",
        method: "notifications/initialized"
      });

      const list = mcpPayload(await messages.nextJson());
      expect(list).toMatchObject({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list"
      });
      socket.send(
        JSON.stringify({
          type: "mcp",
          payload: {
            jsonrpc: "2.0",
            id: 2,
            result: {
              tools: [
                {
                  name: "self.get_device_status",
                  description: "status",
                  inputSchema: { type: "object" }
                },
                {
                  name: "self.audio_speaker.set_volume",
                  description: "volume",
                  inputSchema: { type: "object" }
                }
              ]
            }
          }
        })
      );

      const call = mcpPayload(await messages.nextJson());
      expect(call).toEqual({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "self.audio_speaker.set_volume",
          arguments: { volume: 30 }
        }
      });
      socket.send(
        JSON.stringify({
          type: "mcp",
          payload: {
            jsonrpc: "2.0",
            id: 3,
            result: {
              content: [{ type: "text", text: "true" }],
              isError: false
            }
          }
        })
      );

      await expect(voiceProvider.session.firstToolResult).resolves.toEqual({
        name: "device_set_volume",
        callId: "call-volume",
        ok: true,
        value: true
      });
    } finally {
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
