import { ActionRuntime } from "../actions/runtime.js";
import type { ToolProvider } from "../actions/contracts.js";
import type {
  AudioChunk,
  ProviderUsage,
  VoiceProvider,
  VoiceSession,
  VoiceSessionEvent
} from "../contracts/providers.js";
import type {
  PhoneSessionHandler,
  PhoneSessionTransport
} from "../gateway.js";

export type PhoneVoiceBridgeOptions = {
  voiceProvider: VoiceProvider;
  createToolProviders?: () => ToolProvider[] | Promise<ToolProvider[]>;
  onUsage?: (usage: ProviderUsage) => void | Promise<void>;
  onError?: (error: Error) => void | Promise<void>;
};

class PhoneVoiceSession implements PhoneSessionHandler {
  private readonly unsubscribe: () => void;
  private readonly toolTasks = new Set<Promise<void>>();
  private readonly cancelledToolCalls = new Set<string>();
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly voice: VoiceSession,
    private readonly actions: ActionRuntime | null,
    private readonly transport: PhoneSessionTransport,
    private readonly options: PhoneVoiceBridgeOptions
  ) {
    this.unsubscribe = voice.subscribe((event) => {
      this.chain = this.chain
        .then(() => this.handleVoiceEvent(event))
        .catch((error) => this.reportError(
          error instanceof Error ? error : new Error("Phone voice event failed")
        ));
      return this.chain;
    });
  }

  async onAudio(chunk: AudioChunk): Promise<void> {
    if (this.closed) return;
    if (
      chunk.format !== "pcm16le" ||
      chunk.channels !== 1 ||
      chunk.sampleRate !== 16000
    ) {
      throw new Error("Phone bridge accepts mono PCM16LE at 16 kHz");
    }
    await this.voice.sendAudio(chunk);
  }

  async onEvent(event: unknown): Promise<void> {
    if (this.closed || event === null || typeof event !== "object") return;
    const value = event as Record<string, unknown>;

    if (value.type === "interrupt") {
      await this.voice.interrupt();
      this.transport.sendJson({ type: "audio.clear" });
      return;
    }
    if (value.type === "audio.end") {
      await this.voice.endAudioStream?.();
      return;
    }
    if (
      value.type === "text" &&
      typeof value.text === "string" &&
      value.text.trim().length > 0 &&
      value.text.length <= 4000
    ) {
      if (!this.voice.sendText) {
        throw new Error("Current voice provider does not support text injection");
      }
      await this.voice.sendText(value.text);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    await this.actions?.close();
    await this.chain.catch(() => undefined);
    await Promise.allSettled([...this.toolTasks]);
    await this.voice.close();
  }

  private async handleVoiceEvent(event: VoiceSessionEvent): Promise<void> {
    if (this.closed) return;

    switch (event.type) {
      case "audio":
        this.transport.sendAudio(event.chunk);
        return;
      case "input.transcript":
      case "output.transcript":
        this.transport.sendJson(event);
        return;
      case "output.started":
      case "output.completed":
      case "speech.started":
      case "speech.stopped":
      case "interrupted":
        this.transport.sendJson(event);
        if (event.type === "interrupted") {
          this.transport.sendJson({ type: "audio.clear" });
        }
        return;
      case "usage":
        await this.options.onUsage?.(event.usage);
        return;
      case "tool.call": {
        const task = this.executeTool(event);
        this.toolTasks.add(task);
        void task.finally(() => this.toolTasks.delete(task));
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
            error: "No action runtime is available for the phone session"
          };

      if (this.closed) return;
      if (event.callId && this.cancelledToolCalls.delete(event.callId)) return;
      if (!this.voice.sendToolResult) {
        throw new Error("Current voice provider cannot receive tool results");
      }
      await this.voice.sendToolResult(result);
    } catch (error) {
      if (!this.closed) {
        await this.reportError(
          error instanceof Error ? error : new Error("Phone tool execution failed")
        );
      }
    }
  }

  private async reportError(error: Error): Promise<void> {
    this.transport.sendJson({ type: "error", message: error.message });
    if (this.options.onError) {
      await this.options.onError(error);
    } else {
      console.error("[phone-voice]", error);
    }
  }
}

export class PhoneVoiceBridge {
  constructor(private readonly options: PhoneVoiceBridgeOptions) {}

  readonly createSession = async (
    transport: PhoneSessionTransport
  ): Promise<PhoneSessionHandler> => {
    const providers = this.options.createToolProviders
      ? await this.options.createToolProviders()
      : [];
    const actions =
      providers.length > 0 ? await ActionRuntime.create(providers) : null;

    try {
      const voice = await this.options.voiceProvider.connect(
        actions ? { tools: actions.listTools() } : undefined
      );
      return new PhoneVoiceSession(voice, actions, transport, this.options);
    } catch (error) {
      await actions?.close();
      throw error;
    }
  };
}
