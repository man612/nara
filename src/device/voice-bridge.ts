import type {
  AudioCodecFactory,
  AudioCodecSession
} from "../audio/codec.js";
import type {
  ProviderUsage,
  VoiceProvider,
  VoiceSession,
  VoiceSessionEvent
} from "../contracts/providers.js";
import type {
  FirmwareSessionHandler,
  FirmwareSessionInfo,
  FirmwareSessionTransport
} from "../gateway.js";
import { RealtimePacketPacer } from "./audio-pacer.js";

export type FirmwareVoiceBridgeOptions = {
  voiceProvider: VoiceProvider;
  codecFactory: AudioCodecFactory;
  prebufferPackets?: number;
  onUsage?: (
    session: FirmwareSessionInfo,
    usage: ProviderUsage
  ) => void | Promise<void>;
  onToolCall?: (
    session: FirmwareSessionInfo,
    event: Extract<VoiceSessionEvent, { type: "tool.call" }>
  ) => void | Promise<void>;
  onError?: (
    session: FirmwareSessionInfo,
    error: Error
  ) => void | Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

class FirmwareVoiceSession implements FirmwareSessionHandler {
  private readonly pacer: RealtimePacketPacer;
  private readonly unsubscribeVoice: () => void;
  private voiceEventChain: Promise<void> = Promise.resolve();
  private playbackGeneration = 0;
  private outputActive = false;
  private suppressOutput = false;
  private closed = false;

  constructor(
    private readonly session: FirmwareSessionInfo,
    private readonly transport: FirmwareSessionTransport,
    private readonly codec: AudioCodecSession,
    private readonly voice: VoiceSession,
    private readonly options: FirmwareVoiceBridgeOptions
  ) {
    this.pacer = new RealtimePacketPacer({
      intervalMs: transport.playback.frame_duration,
      prebufferPackets: options.prebufferPackets ?? 5,
      send: (packet) => transport.sendAudio(packet),
      onError: (error) => {
        void this.reportError(error);
      }
    });

    this.unsubscribeVoice = voice.subscribe((event) => {
      this.voiceEventChain = this.voiceEventChain
        .then(() => this.handleVoiceEvent(event))
        .catch(async (error) => {
          await this.reportError(
            error instanceof Error
              ? error
              : new Error("Voice event handling failed")
          );
        });

      return this.voiceEventChain;
    });
  }

  async onAudio(frame: { payload: Uint8Array; timestamp: number }): Promise<void> {
    if (this.closed) return;
    const pcm = await this.codec.decodeUplink(frame.payload);
    await this.voice.sendAudio(pcm);
  }

  async onEvent(event: unknown): Promise<void> {
    if (this.closed || !isRecord(event)) return;
    const type = typeof event.type === "string" ? event.type : "";

    if (type === "abort") {
      this.suppressOutput = true;
      await this.interruptPlayback();
      await this.voice.interrupt();
      return;
    }

    if (type !== "listen") return;

    const state = typeof event.state === "string" ? event.state : "";
    if (state === "start") {
      // Entering listening while output is active is an explicit local
      // barge-in. Stop queued playback immediately; provider audio that follows
      // will be treated as a new response turn.
      if (this.outputActive) {
        this.suppressOutput = true;
        await this.interruptPlayback();
        await this.voice.interrupt();
      }
      return;
    }

    if (state === "stop") {
      // Manual push-to-talk stops the microphone abruptly. Gemini and other
      // automatic-VAD providers need an explicit stream-end hint so they do not
      // wait forever for trailing silence.
      await this.voice.endAudioStream?.();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.playbackGeneration += 1;
    this.outputActive = false;
    this.unsubscribeVoice();
    this.pacer.close();

    await this.voiceEventChain.catch(() => undefined);

    const results = await Promise.allSettled([
      this.codec.close(),
      this.voice.close()
    ]);

    for (const result of results) {
      if (result.status === "rejected") {
        await this.reportError(
          result.reason instanceof Error
            ? result.reason
            : new Error("Voice session cleanup failed")
        );
      }
    }
  }

  private async handleVoiceEvent(event: VoiceSessionEvent): Promise<void> {
    if (this.closed) return;

    switch (event.type) {
      case "audio": {
        if (this.suppressOutput) return;
        const packets = await this.codec.encodeDownlink(event.chunk);
        this.enqueuePlayback(packets);
        return;
      }

      case "output.completed": {
        if (this.suppressOutput) {
          this.suppressOutput = false;
          await this.codec.resetDownlink();
          return;
        }

        const finalPackets = await this.codec.flushDownlink();
        this.enqueuePlayback(finalPackets);
        await this.finishPlayback();
        return;
      }

      case "interrupted":
        await this.interruptPlayback();
        this.suppressOutput = false;
        return;

      case "input.transcript":
        if (event.final && event.text) {
          this.transport.sendJson({
            type: "stt",
            text: event.text,
            session_id: this.session.sessionId
          });
        }
        return;

      case "usage":
        await this.options.onUsage?.(this.session, event.usage);
        return;

      case "tool.call":
        await this.options.onToolCall?.(this.session, event);
        return;

      case "error":
        await this.reportError(new Error(event.message));
        return;

      case "output.started":
      case "output.transcript":
      case "speech.started":
      case "speech.stopped":
        return;
    }
  }

  private enqueuePlayback(packets: Uint8Array[]): void {
    if (packets.length === 0 || this.closed) return;

    if (!this.outputActive) {
      this.outputActive = true;
      this.playbackGeneration += 1;
      this.pacer.beginTurn();
      this.transport.sendJson({
        type: "tts",
        state: "start",
        session_id: this.session.sessionId
      });
    }

    for (const packet of packets) {
      this.pacer.enqueue(packet);
    }
  }

  private async finishPlayback(): Promise<void> {
    if (!this.outputActive || this.closed) return;

    const generation = this.playbackGeneration;
    await this.pacer.endTurn();

    if (
      this.closed ||
      !this.outputActive ||
      generation !== this.playbackGeneration
    ) {
      return;
    }

    this.outputActive = false;
    this.transport.sendJson({
      type: "tts",
      state: "stop",
      session_id: this.session.sessionId
    });
  }

  private async interruptPlayback(): Promise<void> {
    if (this.closed) return;

    this.playbackGeneration += 1;
    const wasActive = this.outputActive;
    this.outputActive = false;
    this.pacer.interrupt();
    await this.codec.resetDownlink();

    if (wasActive) {
      this.transport.sendJson({
        type: "tts",
        state: "stop",
        session_id: this.session.sessionId
      });
    }
  }

  private async reportError(error: Error): Promise<void> {
    if (this.options.onError) {
      await this.options.onError(this.session, error);
      return;
    }

    console.error(`[firmware:${this.session.sessionId}] voice bridge error`, error);
  }
}

export class FirmwareVoiceBridge {
  constructor(private readonly options: FirmwareVoiceBridgeOptions) {}

  readonly createSession = async (
    session: FirmwareSessionInfo,
    transport: FirmwareSessionTransport
  ): Promise<FirmwareSessionHandler> => {
    const codec = await this.options.codecFactory.createSession({
      uplink: {
        sampleRate: session.hello.audio_params.sample_rate,
        channels: session.hello.audio_params.channels,
        frameDurationMs: session.hello.audio_params.frame_duration
      },
      downlink: {
        sampleRate: transport.playback.sample_rate,
        channels: transport.playback.channels,
        frameDurationMs: transport.playback.frame_duration
      }
    });

    let voice: VoiceSession;
    try {
      voice = await this.options.voiceProvider.connect();
    } catch (error) {
      await codec.close();
      throw error;
    }

    return new FirmwareVoiceSession(
      session,
      transport,
      codec,
      voice,
      this.options
    );
  };
}
