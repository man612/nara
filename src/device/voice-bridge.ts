import type {
  AudioCodecFactory,
  AudioCodecSession
} from "../audio/codec.js";
import { ActionRuntime } from "../actions/runtime.js";
import type {
  ToolCall,
  ToolProvider,
  ToolResult
} from "../actions/contracts.js";
import type { FirmwareVoiceControl } from "./voice-control.js";
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
import type { SpeakerIdentityDecision } from "../identity/speaker.js";
import { SpeakerTurnRecognizer } from "../identity/speaker-turn.js";
import { RealtimePacketPacer } from "./audio-pacer.js";
import { DeviceMcpToolProvider } from "./mcp-tools.js";

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
  onControlReady?: (
    session: FirmwareSessionInfo,
    control: FirmwareVoiceControl
  ) => void;
  onControlClosed?: (session: FirmwareSessionInfo) => void;
  onOutputTranscript?: (
    session: FirmwareSessionInfo,
    text: string,
    final: boolean
  ) => void | Promise<void>;

  /**
   * Additional server-side tools bound to this authenticated firmware
   * session. Use this for viewer-scoped memory/search rather than allowing the
   * model to choose identity parameters itself.
   */
  createToolProviders?: (
    session: FirmwareSessionInfo,
    transport: FirmwareSessionTransport
  ) => ToolProvider[] | Promise<ToolProvider[]>;

  createSpeakerRecognizer?: (
    session: FirmwareSessionInfo
  ) => SpeakerTurnRecognizer | undefined;
  onSpeakerIdentity?: (
    session: FirmwareSessionInfo,
    decision: SpeakerIdentityDecision
  ) => void | Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

class FirmwareVoiceSession implements FirmwareSessionHandler {
  private readonly pacer: RealtimePacketPacer;
  private readonly unsubscribeVoice: () => void;
  private readonly toolTasks = new Set<Promise<void>>();
  private readonly speakerTasks = new Set<Promise<void>>();
  private readonly cancelledToolCalls = new Set<string>();
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
    private readonly actions: ActionRuntime | null,
    private readonly speakerRecognizer: SpeakerTurnRecognizer | undefined,
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
    this.speakerRecognizer?.pushAudio(pcm);
    await this.voice.sendAudio(pcm);
  }

  async onEvent(event: unknown): Promise<void> {
    if (this.closed || !isRecord(event)) return;

    if (await this.actions?.onEvent(event)) {
      return;
    }

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
      if (this.outputActive) {
        this.suppressOutput = true;
        await this.interruptPlayback();
        await this.voice.interrupt();
      }
      return;
    }

    if (state === "stop") {
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
    this.speakerRecognizer?.close();

    await this.actions?.close();

    await this.voiceEventChain.catch(() => undefined);
    await Promise.allSettled([...this.toolTasks, ...this.speakerTasks]);

    const results = await Promise.allSettled([
      this.codec.close(),
      this.voice.close()
    ]);

    this.options.onControlClosed?.(this.session);

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

  async sendText(text: string): Promise<void> {
    if (this.closed) {
      throw new Error("Firmware voice session is closed");
    }
    if (!this.voice.sendText) {
      throw new Error("Current voice provider does not support text injection");
    }
    await this.voice.sendText(text);
  }

  async executeTool(call: ToolCall): Promise<ToolResult> {
    if (this.closed) {
      return {
        name: call.name,
        ok: false,
        ...(call.callId ? { callId: call.callId } : {}),
        error: "Firmware voice session is closed"
      };
    }
    if (!this.actions) {
      return {
        name: call.name,
        ok: false,
        ...(call.callId ? { callId: call.callId } : {}),
        error: "No action runtime is available for this session"
      };
    }
    return this.actions.execute(call);
  }

  async interrupt(): Promise<void> {
    if (this.closed) return;
    this.suppressOutput = true;
    await this.interruptPlayback();
    await this.voice.interrupt();
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

      case "tool.call": {
        await this.options.onToolCall?.(this.session, event);
        const task = this.executeTool(event);
        this.toolTasks.add(task);
        void task.finally(() => {
          this.toolTasks.delete(task);
        });
        return;
      }

      case "tool.cancel":
        for (const callId of event.callIds) {
          this.cancelledToolCalls.add(callId);
        }
        this.actions?.cancel(event.callIds);
        return;

      case "error":
        await this.reportError(new Error(event.message));
        return;

      case "speech.started":
        this.speakerRecognizer?.speechStarted();
        return;

      case "speech.stopped": {
        if (!this.speakerRecognizer) return;
        const task = this.identifySpeakerTurn();
        this.speakerTasks.add(task);
        void task.finally(() => {
          this.speakerTasks.delete(task);
        });
        return;
      }

      case "output.transcript":
        await this.options.onOutputTranscript?.(
          this.session,
          event.text,
          event.final
        );
        return;

      case "output.started":
        return;
    }
  }

  private async identifySpeakerTurn(): Promise<void> {
    try {
      const decision = await this.speakerRecognizer?.speechStopped();
      if (!decision || this.closed) return;
      await this.options.onSpeakerIdentity?.(this.session, decision);
    } catch (error) {
      if (this.closed) return;
      await this.reportError(
        error instanceof Error
          ? error
          : new Error("Speaker identity failed")
      );
    }
  }

  private async executeTool(
    event: Extract<VoiceSessionEvent, { type: "tool.call" }>
  ): Promise<void> {
    try {
      const result = this.actions
        ? await this.actions.execute({
            name: event.name,
            arguments: event.arguments,
            ...(event.callId ? { callId: event.callId } : {})
          })
        : {
            name: event.name,
            ok: false,
            ...(event.callId ? { callId: event.callId } : {}),
            error: "No action runtime is available for this session"
          };

      if (this.closed) return;

      if (
        event.callId &&
        this.cancelledToolCalls.delete(event.callId)
      ) {
        return;
      }

      if (!this.voice.sendToolResult) {
        await this.reportError(
          new Error(
            `Voice provider requested tool ${event.name} but cannot receive tool results`
          )
        );
        return;
      }

      await this.voice.sendToolResult(result);
    } catch (error) {
      if (this.closed) return;
      await this.reportError(
        error instanceof Error
          ? error
          : new Error("Tool execution failed")
      );
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

    const toolProviders: ToolProvider[] = [];
    const supportsDeviceMcp = session.hello.features?.mcp === true;
    if (supportsDeviceMcp) {
      toolProviders.push(new DeviceMcpToolProvider(transport));
    }

    if (this.options.createToolProviders) {
      toolProviders.push(
        ...(await this.options.createToolProviders(session, transport))
      );
    }

    const actions =
      toolProviders.length > 0
        ? await ActionRuntime.create(toolProviders)
        : null;

    let voice: VoiceSession;
    try {
      voice = await this.options.voiceProvider.connect(
        actions ? { tools: actions.listTools() } : undefined
      );
    } catch (error) {
      await Promise.allSettled([
        codec.close(),
        actions?.close() ?? Promise.resolve()
      ]);
      throw error;
    }

    const speakerRecognizer =
      this.options.createSpeakerRecognizer?.(session);

    const handler = new FirmwareVoiceSession(
      session,
      transport,
      codec,
      voice,
      actions,
      speakerRecognizer,
      this.options
    );
    this.options.onControlReady?.(session, handler);
    return handler;
  };
}
