import WebSocket, { type RawData } from "ws";
import type {
  ToolDefinition,
  ToolResult
} from "../../actions/contracts.js";
import type {
  AudioChunk,
  ProviderUsage,
  VoiceConnectOptions,
  VoiceEventHandler,
  VoiceProvider,
  VoiceSession,
  VoiceSessionEvent
} from "../../contracts/providers.js";

const DEFAULT_MODEL = "gemini-3.8-live";
const DEFAULT_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const SETUP_TIMEOUT_MS = 15000;
const WS_OPEN = 1;
const MAX_RECONNECT_OUTBOX_BYTES = 128 * 1024;
const MAX_RECONNECT_OUTBOX_MESSAGES = 256;

type OutboxEntry = {
  serialized: string;
  bytes: number;
  audio: boolean;
};

type GeminiSocket = {
  readonly readyState: number;
  on(event: "open", listener: () => void): unknown;
  on(
    event: "message",
    listener: (data: RawData, isBinary: boolean) => void
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(
    event: "close",
    listener: (code: number, reason: Buffer) => void
  ): unknown;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type GeminiSocketFactory = (url: string) => GeminiSocket;

export type GeminiLiveOptions = {
  apiKey: string;
  model?: string;
  systemInstruction?: string;
  inputTranscription?: boolean;
  outputTranscription?: boolean;
  endpoint?: string;
  socketFactory?: GeminiSocketFactory;
};

type GeminiServerContent = {
  modelTurn?: {
    parts?: Array<{
      inlineData?: {
        data?: string;
        mimeType?: string;
      };
    }>;
  };
  interrupted?: boolean;
  turnComplete?: boolean;
  inputTranscription?: { text?: string };
  interimInputTranscription?: { text?: string };
  outputTranscription?: { text?: string };
};

type GeminiServerMessage = {
  setupComplete?: Record<string, unknown>;
  serverContent?: GeminiServerContent;
  sessionResumptionUpdate?: {
    resumable?: boolean;
    newHandle?: string;
  };
  goAway?: {
    timeLeft?: string;
  };
  usageMetadata?: {
    promptTokenCount?: number;
    responseTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  toolCall?: {
    functionCalls?: Array<{
      id?: string;
      name?: string;
      args?: unknown;
    }>;
  };
  toolCallCancellation?: {
    ids?: string[];
  };
};

function defaultSocketFactory(url: string): GeminiSocket {
  return new WebSocket(url);
}

function parsePcmRate(mimeType: string | undefined): number {
  if (!mimeType) return 24000;
  const match = /(?:^|;)rate=(\d+)(?:;|$)/i.exec(mimeType);
  return match ? Number(match[1]) : 24000;
}

export function normalizeGeminiLiveUsage(
  usage: GeminiServerMessage["usageMetadata"]
): ProviderUsage | undefined {
  if (!usage) return undefined;

  const inputTokens = usage.promptTokenCount;
  const outputTokens = usage.responseTokenCount;
  const cachedInputTokens = usage.cachedContentTokenCount;
  const totalTokens =
    usage.totalTokenCount ??
    (inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cachedInputTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(inputTokens !== undefined && cachedInputTokens !== undefined
      ? { uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens) }
      : {})
  };
}

export class GeminiLiveVoiceProvider implements VoiceProvider {
  readonly id: string;
  private readonly options: GeminiLiveOptions;

  constructor(id: string, options: GeminiLiveOptions) {
    if (!options.apiKey) {
      throw new Error("Gemini Live API key is required");
    }
    this.id = id;
    this.options = options;
  }

  async connect(options: VoiceConnectOptions = {}): Promise<VoiceSession> {
    return GeminiLiveVoiceSession.connect(
      this.id,
      this.options,
      options.tools ?? []
    );
  }
}

class GeminiLiveVoiceSession implements VoiceSession {
  private readonly options: GeminiLiveOptions;
  private readonly tools: ToolDefinition[];
  private readonly socketFactory: GeminiSocketFactory;
  private readonly handlers = new Set<VoiceEventHandler>();
  private socket: GeminiSocket | null = null;
  private pendingSocket: GeminiSocket | null = null;
  private reconnecting: Promise<void> | null = null;
  private resumptionHandle: string | null = null;
  private reconnectRequested = false;
  private closed = false;
  private outputActive = false;
  private serverEventChain: Promise<void> = Promise.resolve();
  private readonly outbox: OutboxEntry[] = [];
  private outboxBytes = 0;

  private constructor(
    private readonly providerId: string,
    options: GeminiLiveOptions,
    tools: ToolDefinition[]
  ) {
    this.options = options;
    this.tools = tools;
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
  }

  static async connect(
    providerId: string,
    options: GeminiLiveOptions,
    tools: ToolDefinition[]
  ): Promise<GeminiLiveVoiceSession> {
    const session = new GeminiLiveVoiceSession(
      providerId,
      options,
      tools
    );
    await session.openSocket(null, true);
    return session;
  }

  subscribe(handler: VoiceEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async sendAudio(chunk: AudioChunk): Promise<void> {
    this.assertOpen();
    if (chunk.format !== "pcm16le") {
      throw new Error("Gemini Live requires PCM16LE audio");
    }
    if (chunk.channels !== 1) {
      throw new Error("Gemini Live audio input must be mono");
    }
    if (chunk.sampleRate !== 16000) {
      throw new Error(
        `Gemini Live Nara path expects native 16000 Hz input, got ${chunk.sampleRate}`
      );
    }
    if (chunk.data.byteLength === 0 || chunk.data.byteLength % 2 !== 0) {
      throw new Error("Gemini Live PCM16 input must contain whole samples");
    }

    const data = Buffer.from(
      chunk.data.buffer,
      chunk.data.byteOffset,
      chunk.data.byteLength
    ).toString("base64");

    this.sendJson(
      {
        realtimeInput: {
          audio: {
            data,
            mimeType: "audio/pcm;rate=16000"
          }
        }
      },
      true
    );
  }

  async sendText(text: string): Promise<void> {
    this.assertOpen();
    if (!text) return;
    this.sendJson({ realtimeInput: { text } });
  }

  async endAudioStream(): Promise<void> {
    this.assertOpen();
    this.sendJson({
      realtimeInput: {
        audioStreamEnd: true
      }
    });
  }

  async sendToolResult(result: ToolResult): Promise<void> {
    this.assertOpen();

    const response: Record<string, unknown> = result.ok
      ? { result: result.value ?? null }
      : { error: result.error ?? "Tool execution failed" };

    const scheduling = result.scheduling
      ? result.scheduling === "when_idle"
        ? "WHEN_IDLE"
        : result.scheduling.toUpperCase()
      : undefined;

    this.sendJson({
      toolResponse: {
        functionResponses: [
          {
            name: result.name,
            ...(result.callId ? { id: result.callId } : {}),
            response,
            ...(scheduling ? { scheduling } : {})
          }
        ]
      }
    });
  }

  async interrupt(): Promise<void> {
    this.assertOpen();
    // With automatic activity detection, Gemini's documented barge-in path is
    // the start of the next user activity. There is no separate cancel message
    // we can send without changing the conversation semantics. Do not emit a
    // synthetic interruption here: consumers must wait for the server's real
    // interrupted event so stale output can be suppressed safely.
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.reconnectRequested = false;
    this.outbox.length = 0;
    this.outboxBytes = 0;

    const sockets = [this.socket, this.pendingSocket].filter(
      (socket): socket is GeminiSocket => socket !== null
    );
    this.socket = null;
    this.pendingSocket = null;

    for (const socket of sockets) {
      try {
        socket.close(1000, "nara session closed");
      } catch {
        // Socket may already be closing/closed.
      }
    }
  }

  private async openSocket(
    handle: string | null,
    initial: boolean
  ): Promise<void> {
    const endpoint = this.options.endpoint ?? DEFAULT_ENDPOINT;
    const url = `${endpoint}?key=${encodeURIComponent(this.options.apiKey)}`;
    const socket = this.socketFactory(url);
    this.pendingSocket = socket;

    await new Promise<void>((resolve, reject) => {
      let ready = false;
      const timer = setTimeout(() => {
        if (!ready) {
          reject(new Error("Gemini Live setup timed out"));
          try {
            socket.close(1011, "setup timeout");
          } catch {
            // Ignore close races.
          }
        }
      }, SETUP_TIMEOUT_MS);

      const failSetup = (error: Error) => {
        if (ready) return;
        clearTimeout(timer);
        reject(error);
      };

      socket.on("open", () => {
        try {
          socket.send(JSON.stringify(this.buildSetupMessage(handle)));
        } catch (error) {
          failSetup(
            error instanceof Error ? error : new Error("Failed to send Gemini setup")
          );
        }
      });

      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          void this.emit({ type: "error", message: "Gemini sent unexpected binary WebSocket data" });
          return;
        }

        let message: GeminiServerMessage;
        try {
          message = JSON.parse(data.toString()) as GeminiServerMessage;
        } catch {
          void this.emit({ type: "error", message: "Gemini sent invalid JSON" });
          return;
        }

        if (message.setupComplete && !ready) {
          ready = true;
          clearTimeout(timer);
          const previous = this.socket;
          this.socket = socket;
          this.pendingSocket = null;
          this.flushOutbox();

          if (previous && previous !== socket) {
            try {
              previous.close(1000, "session resumed");
            } catch {
              // Ignore close races.
            }
          }

          resolve();
        }

        this.serverEventChain = this.serverEventChain
          .then(() => this.handleServerMessage(message))
          .catch(async (error) => {
            await this.emit({
              type: "error",
              message:
                error instanceof Error
                  ? `Gemini message handling failed: ${error.message}`
                  : "Gemini message handling failed"
            });
          });
      });

      socket.on("error", (error) => {
        if (!ready) {
          failSetup(error);
        }
        void this.emit({ type: "error", message: error.message });
      });

      socket.on("close", (code, reason) => {
        if (!ready) {
          failSetup(
            new Error(
              `Gemini Live closed during setup (${code}): ${reason.toString()}`
            )
          );
          return;
        }

        if (this.socket === socket) {
          this.socket = null;
          if (!this.closed) {
            void this.requestReconnect();
          }
        }
      });
    });

    if (initial && this.closed) {
      throw new Error("Gemini Live session closed during setup");
    }
  }

  private buildSetupMessage(handle: string | null): Record<string, unknown> {
    const setup: Record<string, unknown> = {
      model: `models/${this.options.model ?? DEFAULT_MODEL}`,
      generationConfig: {
        responseModalities: ["AUDIO"]
      },
      sessionResumption: handle ? { handle } : {},
      contextWindowCompression: {
        slidingWindow: {}
      }
    };

    if (this.options.systemInstruction) {
      setup.systemInstruction = {
        parts: [{ text: this.options.systemInstruction }]
      };
    }
    if (this.options.inputTranscription) {
      setup.inputAudioTranscription = {};
    }
    if (this.options.outputTranscription) {
      setup.outputAudioTranscription = {};
    }
    if (this.tools.length > 0) {
      setup.tools = [
        {
          functionDeclarations: this.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parametersJsonSchema: tool.inputSchema,
            behavior:
              tool.behavior === "non_blocking"
                ? "NON_BLOCKING"
                : "BLOCKING"
          }))
        }
      ];
    }

    return { setup };
  }

  private async handleServerMessage(message: GeminiServerMessage): Promise<void> {
    const update = message.sessionResumptionUpdate;
    if (update?.resumable && update.newHandle) {
      this.resumptionHandle = update.newHandle;
      if (this.reconnectRequested) {
        void this.requestReconnect();
      }
    }

    if (message.goAway) {
      this.reconnectRequested = true;
      if (this.resumptionHandle) {
        void this.requestReconnect();
      }
    }

    const usage = normalizeGeminiLiveUsage(message.usageMetadata);
    if (usage) {
      await this.emit({ type: "usage", usage });
    }

    const content = message.serverContent;
    if (content) {
      const modelParts = content.modelTurn?.parts ?? [];
      if (modelParts.length > 0 && !this.outputActive) {
        this.outputActive = true;
        await this.emit({ type: "output.started" });
      }

      for (const part of modelParts) {
        const inline = part.inlineData;
        if (!inline?.data) continue;

        const rate = parsePcmRate(inline.mimeType);
        await this.emit({
          type: "audio",
          chunk: {
            format: "pcm16le",
            data: Uint8Array.from(Buffer.from(inline.data, "base64")),
            sampleRate: rate,
            channels: 1
          }
        });
      }

      if (content.interimInputTranscription?.text) {
        await this.emit({
          type: "input.transcript",
          text: content.interimInputTranscription.text,
          final: false
        });
      }
      if (content.inputTranscription?.text) {
        await this.emit({
          type: "input.transcript",
          text: content.inputTranscription.text,
          final: true
        });
      }
      if (content.outputTranscription?.text) {
        await this.emit({
          type: "output.transcript",
          text: content.outputTranscription.text,
          final: Boolean(content.turnComplete)
        });
      }
      if (content.interrupted) {
        this.outputActive = false;
        await this.emit({ type: "interrupted" });
      } else if (content.turnComplete && this.outputActive) {
        this.outputActive = false;
        await this.emit({ type: "output.completed" });
      }
    }

    for (const call of message.toolCall?.functionCalls ?? []) {
      if (!call.name) continue;
      const event: VoiceSessionEvent = {
        type: "tool.call",
        name: call.name,
        arguments: call.args ?? {}
      };
      if (call.id) event.callId = call.id;
      await this.emit(event);
    }

    const cancelledIds = message.toolCallCancellation?.ids ?? [];
    if (cancelledIds.length > 0) {
      await this.emit({
        type: "tool.cancel",
        callIds: cancelledIds
      });
    }
  }

  private async requestReconnect(): Promise<void> {
    if (this.closed || this.reconnecting) return this.reconnecting ?? undefined;

    this.reconnecting = (async () => {
      try {
        await this.openSocket(this.resumptionHandle, false);
        this.reconnectRequested = false;
      } catch (error) {
        const message =
          error instanceof Error
            ? `Gemini reconnect failed: ${error.message}`
            : "Gemini reconnect failed";
        await this.emit({
          type: "error",
          message
        });
        await this.emit({
          type: "session.disconnected",
          providerId: this.providerId,
          reason: message,
          recoverable: true
        });
      } finally {
        this.reconnecting = null;
      }
    })();

    return this.reconnecting;
  }

  private sendJson(payload: unknown, audio = false): void {
    const serialized = JSON.stringify(payload);
    const socket = this.socket;
    if (socket && socket.readyState === WS_OPEN) {
      socket.send(serialized);
      return;
    }

    const entry: OutboxEntry = {
      serialized,
      bytes: Buffer.byteLength(serialized),
      audio
    };
    if (!this.makeOutboxRoom(entry)) {
      if (audio) return;
      throw new Error("Gemini Live reconnect queue is full");
    }

    this.outbox.push(entry);
    this.outboxBytes += entry.bytes;
  }

  private makeOutboxRoom(entry: OutboxEntry): boolean {
    while (
      this.outboxBytes + entry.bytes > MAX_RECONNECT_OUTBOX_BYTES ||
      this.outbox.length >= MAX_RECONNECT_OUTBOX_MESSAGES
    ) {
      const audioIndex = this.outbox.findIndex((candidate) => candidate.audio);
      if (audioIndex < 0) return false;
      const [dropped] = this.outbox.splice(audioIndex, 1);
      if (dropped) this.outboxBytes -= dropped.bytes;
    }
    return true;
  }

  private flushOutbox(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WS_OPEN) return;

    while (this.outbox.length > 0) {
      const message = this.outbox.shift();
      if (!message) continue;
      this.outboxBytes -= message.bytes;
      socket.send(message.serialized);
    }
  }

  private async emit(event: VoiceSessionEvent): Promise<void> {
    for (const handler of [...this.handlers]) {
      await handler(event);
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("Gemini Live session is closed");
    }
  }
}
