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

const DEFAULT_ENDPOINT = "wss://api.openai.com/v1/live/sessions";
const DEFAULT_MODEL = "gpt-live-1";
const DEFAULT_BACKEND_MODEL = "gpt-5.6-luna";
const DEFAULT_VOICE = "marin";
const DEFAULT_OUTPUT_IDLE_MS = 450;
const DEFAULT_SETUP_TIMEOUT_MS = 15_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
const WS_OPEN = 1;

type OpenAILiveSocket = {
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

export type OpenAILiveSocketFactory = (
  url: string,
  headers: Record<string, string>
) => OpenAILiveSocket;

export type OpenAILiveOptions = {
  apiKey: string;
  model?: string;
  backendModel?: string;
  voice?: string;
  systemInstruction?: string;
  backendInstructions?: string;
  endpoint?: string;
  outputIdleMs?: number;
  setupTimeoutMs?: number;
  closeTimeoutMs?: number;
  socketFactory?: OpenAILiveSocketFactory;
};

type OpenAILiveMessage = {
  type?: unknown;
  delta?: unknown;
  error?: {
    message?: unknown;
  };
  event?: unknown;
  session?: unknown;
  usage?: unknown;
};

function defaultSocketFactory(
  url: string,
  headers: Record<string, string>
): OpenAILiveSocket {
  return new WebSocket(url, { headers });
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: "Unserializable tool result" });
  }
}

function parseToolArguments(value: unknown): unknown {
  if (typeof value !== "string") {
    return value ?? {};
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function normalizeOpenAILiveSessionUsage(
  value: unknown
): ProviderUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const seconds = finiteNumber(
    (value as Record<string, unknown>).seconds
  );
  if (seconds === undefined || seconds < 0) return undefined;
  return { voiceSeconds: seconds };
}

export function normalizeOpenAILiveBackendUsage(
  value: unknown
): ProviderUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as Record<string, unknown>;
  const inputTokens = finiteNumber(usage.input_tokens);
  const outputTokens = finiteNumber(usage.output_tokens);
  const totalTokens =
    finiteNumber(usage.total_tokens) ??
    (inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined);

  const inputDetails =
    usage.input_tokens_details &&
    typeof usage.input_tokens_details === "object"
      ? (usage.input_tokens_details as Record<string, unknown>)
      : undefined;
  const cachedInputTokens = finiteNumber(inputDetails?.cached_tokens);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    cachedInputTokens === undefined
  ) {
    return undefined;
  }

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(inputTokens !== undefined && cachedInputTokens !== undefined
      ? {
          uncachedInputTokens: Math.max(
            0,
            inputTokens - cachedInputTokens
          )
        }
      : {})
  };
}

function toResponseTools(tools: ToolDefinition[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema
  }));
}

export class OpenAILiveVoiceProvider implements VoiceProvider {
  readonly id: string;

  constructor(
    id: string,
    private readonly options: OpenAILiveOptions
  ) {
    if (!options.apiKey) {
      throw new Error("OpenAI Live API key is required");
    }
    this.id = id;
  }

  async connect(
    options: VoiceConnectOptions = {}
  ): Promise<VoiceSession> {
    return OpenAILiveVoiceSession.connect(
      this.options,
      options.tools ?? []
    );
  }
}

class OpenAILiveVoiceSession implements VoiceSession {
  private readonly handlers = new Set<VoiceEventHandler>();
  private readonly tools: ToolDefinition[];
  private readonly socketFactory: OpenAILiveSocketFactory;
  private readonly pendingTools = new Set<string>();
  private readonly seenBackendResponseIds = new Set<string>();
  private readonly outputIdleMs: number;
  private readonly closeTimeoutMs: number;
  private socket: OpenAILiveSocket | null = null;
  private closed = false;
  private closing = false;
  private started = false;
  private suppressOutput = false;
  private outputActive = false;
  private outputIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private outputTranscript = "";
  private inputTranscript = "";
  private lastVoiceSeconds: number | null = null;
  private serverEventChain: Promise<void> = Promise.resolve();
  private closeResolver: (() => void) | null = null;

  private constructor(
    private readonly options: OpenAILiveOptions,
    tools: ToolDefinition[]
  ) {
    this.tools = tools;
    this.socketFactory =
      options.socketFactory ?? defaultSocketFactory;
    this.outputIdleMs =
      options.outputIdleMs ?? DEFAULT_OUTPUT_IDLE_MS;
    this.closeTimeoutMs =
      options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  }

  static async connect(
    options: OpenAILiveOptions,
    tools: ToolDefinition[]
  ): Promise<OpenAILiveVoiceSession> {
    const session = new OpenAILiveVoiceSession(options, tools);
    await session.open();
    return session;
  }

  subscribe(handler: VoiceEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async sendAudio(chunk: AudioChunk): Promise<void> {
    this.assertOpen();
    if (
      chunk.format !== "pcm16le" ||
      chunk.channels !== 1 ||
      chunk.sampleRate !== 16_000 ||
      chunk.data.byteLength === 0 ||
      chunk.data.byteLength % 2 !== 0
    ) {
      throw new Error(
        "OpenAI Live expects non-empty mono PCM16LE at 16 kHz"
      );
    }

    this.suppressOutput = false;
    this.send({
      type: "session.input_audio.append",
      audio: Buffer.from(
        chunk.data.buffer,
        chunk.data.byteOffset,
        chunk.data.byteLength
      ).toString("base64")
    });
  }

  async endAudioStream(): Promise<void> {
    this.assertOpen();
    // GPT-Live owns turn detection on its continuous audio stream. Nara's
    // manual listen-stop boundary is retained for local latency accounting;
    // no provider-side audio-end command is required.
  }

  async sendText(textInput: string): Promise<void> {
    this.assertOpen();
    const text = textInput.trim();
    if (!text) return;

    this.suppressOutput = false;
    this.send({
      type: "response.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }]
      }
    });
    this.send({ type: "response.create" });
  }

  async sendToolResult(result: ToolResult): Promise<void> {
    this.assertOpen();
    if (!result.callId) {
      throw new Error("OpenAI Live tool results require callId");
    }
    if (!this.pendingTools.has(result.callId)) {
      throw new Error(
        `No pending OpenAI Live tool call ${result.callId}`
      );
    }

    this.pendingTools.delete(result.callId);
    this.send({
      type: "response.item.create",
      item: {
        type: "function_call_output",
        call_id: result.callId,
        output: safeJson(
          result.ok
            ? result.value ?? null
            : { error: result.error ?? "Tool execution failed" }
        )
      }
    });
    this.send({ type: "response.create" });
  }

  async interrupt(): Promise<void> {
    if (this.closed) return;
    this.suppressOutput = true;
    this.clearOutputIdleTimer();

    // Speech/playback interruption and backend action cancellation are
    // deliberately separate lifecycles. A user cutting off spoken output
    // must not silently cancel an in-flight search or device/tool action.
    const hadOutput =
      this.outputActive || this.outputTranscript.length > 0;
    this.outputActive = false;
    this.outputTranscript = "";
    if (hadOutput) {
      await this.emit({ type: "interrupted" });
    }
  }

  async close(): Promise<void> {
    if (this.closed || this.closing) return;
    this.closing = true;
    this.clearOutputIdleTimer();

    const socket = this.socket;
    if (!socket) {
      this.closed = true;
      return;
    }

    if (socket.readyState === WS_OPEN && this.started) {
      try {
        socket.send(JSON.stringify({ type: "session.close" }));
      } catch {
        // Transport may already be closing.
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.closeTimeoutMs);
        this.closeResolver = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }

    this.closed = true;
    this.started = false;
    this.closeResolver = null;
    this.socket = null;
    try {
      socket.close(1000, "nara session closed");
    } catch {
      // Socket may already be closed.
    }
  }

  private async open(): Promise<void> {
    const endpoint = this.options.endpoint ?? DEFAULT_ENDPOINT;
    const socket = this.socketFactory(endpoint, {
      Authorization: `Bearer ${this.options.apiKey}`
    });
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let ready = false;
      const timeout = setTimeout(() => {
        if (ready) return;
        reject(new Error("OpenAI Live setup timed out"));
        try {
          socket.close(1011, "setup timeout");
        } catch {
          // Ignore close race.
        }
      }, this.options.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS);

      const failSetup = (error: Error) => {
        if (ready) return;
        clearTimeout(timeout);
        reject(error);
      };

      socket.on("open", () => {
        try {
          socket.send(JSON.stringify(this.buildSessionStart()));
        } catch (error) {
          failSetup(
            error instanceof Error
              ? error
              : new Error("Failed to start OpenAI Live session")
          );
        }
      });

      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          void this.emit({
            type: "error",
            message: "OpenAI Live sent unexpected binary WebSocket data"
          });
          return;
        }

        let message: OpenAILiveMessage;
        try {
          message = JSON.parse(data.toString()) as OpenAILiveMessage;
        } catch {
          void this.emit({
            type: "error",
            message: "OpenAI Live sent invalid JSON"
          });
          return;
        }

        if (message.type === "session.started" && !ready) {
          ready = true;
          this.started = true;
          clearTimeout(timeout);
          resolve();
        }

        this.serverEventChain = this.serverEventChain
          .then(() => this.handleMessage(message))
          .catch(async (error) => {
            await this.emit({
              type: "error",
              message:
                error instanceof Error
                  ? `OpenAI Live event handling failed: ${error.message}`
                  : "OpenAI Live event handling failed"
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
        this.closeResolver?.();
        if (!ready) {
          failSetup(
            new Error(
              `OpenAI Live closed during setup (${code}): ${reason.toString()}`
            )
          );
          return;
        }
        if (!this.closing && !this.closed) {
          void this.emit({
            type: "error",
            message:
              `OpenAI Live connection closed (${code}): ${reason.toString()}`
          });
        }
      });
    });
  }

  private buildSessionStart(): Record<string, unknown> {
    const responseTools = toResponseTools(this.tools);

    return {
      type: "session.start",
      session: {
        model: this.options.model ?? DEFAULT_MODEL,
        instructions:
          this.options.systemInstruction ??
          "Be concise and natural. Delegate requests requiring tools or backend reasoning instead of guessing.",
        audio: {
          format: { type: "audio/pcm", rate: 16_000 },
          output: {
            voice: this.options.voice ?? DEFAULT_VOICE
          }
        },
        delegation: {
          type: "responses",
          responses: {
            model:
              this.options.backendModel ??
              DEFAULT_BACKEND_MODEL,
            ...(this.options.backendInstructions
              ? {
                  instructions:
                    this.options.backendInstructions
                }
              : {}),
            ...(responseTools.length > 0
              ? {
                  tools: responseTools,
                  tool_choice: "auto"
                }
              : {
                  tools: [],
                  tool_choice: "none"
                }),
            parallel_tool_calls: false
          }
        }
      }
    };
  }

  private async handleMessage(
    message: OpenAILiveMessage
  ): Promise<void> {
    const type =
      typeof message.type === "string" ? message.type : "";

    if (type === "session.output_audio.delta") {
      if (typeof message.delta !== "string") return;
      if (this.suppressOutput) return;

      await this.finalizeInputTranscript();
      if (!this.outputActive) {
        this.outputActive = true;
        await this.emit({ type: "output.started" });
      }

      await this.emit({
        type: "audio",
        chunk: {
          format: "pcm16le",
          data: Uint8Array.from(
            Buffer.from(message.delta, "base64")
          ),
          sampleRate: 16_000,
          channels: 1
        }
      });
      this.scheduleOutputCompletion();
      return;
    }

    if (type === "session.input_transcript.delta") {
      if (typeof message.delta !== "string") return;
      this.inputTranscript += message.delta;
      await this.emit({
        type: "input.transcript",
        text: message.delta,
        final: false
      });
      return;
    }

    if (type === "session.output_transcript.delta") {
      if (
        typeof message.delta !== "string" ||
        this.suppressOutput
      ) {
        return;
      }
      this.outputTranscript += message.delta;
      await this.emit({
        type: "output.transcript",
        text: message.delta,
        final: false
      });
      this.scheduleOutputCompletion();
      return;
    }

    if (type === "session.usage.updated") {
      await this.emitVoiceUsage(message.usage);
      return;
    }

    if (type === "response.event") {
      await this.handleResponseEvent(message.event);
      return;
    }

    if (type === "session.closed") {
      await this.emitVoiceUsage(message.usage);
      await this.finishOutput();
      await this.finalizeInputTranscript();
      this.closeResolver?.();
      return;
    }

    if (type === "error") {
      const detail =
        typeof message.error?.message === "string"
          ? message.error.message
          : "OpenAI Live session error";
      await this.emit({ type: "error", message: detail });
    }
  }

  private async handleResponseEvent(
    nested: unknown
  ): Promise<void> {
    if (!nested || typeof nested !== "object") return;
    const event = nested as Record<string, unknown>;
    const type =
      typeof event.type === "string" ? event.type : "";

    if (type === "response.output_item.done") {
      const item =
        event.item && typeof event.item === "object"
          ? (event.item as Record<string, unknown>)
          : undefined;
      if (
        item?.type === "function_call" &&
        typeof item.call_id === "string" &&
        typeof item.name === "string"
      ) {
        this.pendingTools.add(item.call_id);
        await this.emit({
          type: "tool.call",
          name: item.name,
          arguments: parseToolArguments(item.arguments),
          callId: item.call_id
        });
      }
      return;
    }

    if (type === "response.completed") {
      const response =
        event.response && typeof event.response === "object"
          ? (event.response as Record<string, unknown>)
          : undefined;
      const responseId =
        typeof response?.id === "string" ? response.id : undefined;
      if (
        responseId &&
        this.seenBackendResponseIds.has(responseId)
      ) {
        return;
      }
      if (responseId) {
        this.seenBackendResponseIds.add(responseId);
      }

      const usage = normalizeOpenAILiveBackendUsage(
        response?.usage
      );
      if (usage) {
        await this.emit({ type: "usage", usage });
      }
    }
  }

  private async emitVoiceUsage(value: unknown): Promise<void> {
    const usage = normalizeOpenAILiveSessionUsage(value);
    if (
      !usage ||
      usage.voiceSeconds === undefined ||
      usage.voiceSeconds === this.lastVoiceSeconds
    ) {
      return;
    }
    this.lastVoiceSeconds = usage.voiceSeconds;
    await this.emit({ type: "usage", usage });
  }

  private scheduleOutputCompletion(): void {
    this.clearOutputIdleTimer();
    this.outputIdleTimer = setTimeout(() => {
      this.outputIdleTimer = null;
      void this.finishOutput().catch((error) => {
        void this.emit({
          type: "error",
          message:
            error instanceof Error
              ? error.message
              : "OpenAI Live output completion failed"
        });
      });
    }, this.outputIdleMs);
  }

  private async finishOutput(): Promise<void> {
    this.clearOutputIdleTimer();
    if (!this.outputActive) return;

    this.outputActive = false;
    if (this.outputTranscript) {
      const text = this.outputTranscript;
      this.outputTranscript = "";
      await this.emit({
        type: "output.transcript",
        text,
        final: true
      });
    }
    await this.emit({ type: "output.completed" });
  }

  private async finalizeInputTranscript(): Promise<void> {
    if (!this.inputTranscript) return;
    const text = this.inputTranscript;
    this.inputTranscript = "";
    await this.emit({
      type: "input.transcript",
      text,
      final: true
    });
  }

  private clearOutputIdleTimer(): void {
    if (this.outputIdleTimer) {
      clearTimeout(this.outputIdleTimer);
      this.outputIdleTimer = null;
    }
  }

  private send(payload: unknown): void {
    this.assertOpen();
    this.socket!.send(JSON.stringify(payload));
  }

  private async emit(event: VoiceSessionEvent): Promise<void> {
    for (const handler of [...this.handlers]) {
      await handler(event);
    }
  }

  private assertOpen(): void {
    if (
      this.closed ||
      this.closing ||
      !this.started ||
      !this.socket ||
      this.socket.readyState !== WS_OPEN
    ) {
      throw new Error("OpenAI Live session is not open");
    }
  }
}
