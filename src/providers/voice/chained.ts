import type {
  ToolDefinition,
  ToolResult
} from "../../actions/contracts.js";
import type {
  AudioChunk,
  BrainMessage,
  BrainProvider,
  BrainToolCall,
  SpeechToTextProvider,
  TextToSpeechProvider,
  VoiceConnectOptions,
  VoiceEventHandler,
  VoiceProvider,
  VoiceSession,
  VoiceSessionEvent
} from "../../contracts/providers.js";

export type ChainedVoiceOptions = {
  stt: SpeechToTextProvider;
  brain: BrainProvider;
  tts: TextToSpeechProvider;
  systemInstruction?: string;
  maxBufferedAudioBytes?: number;
  maxHistoryMessages?: number;
  maxToolRounds?: number;
};

const DEFAULT_MAX_AUDIO_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_HISTORY_MESSAGES = 40;
const DEFAULT_MAX_TOOL_ROUNDS = 8;
const TTS_CHUNK_CHARS = 3_600;

type PendingTool = {
  resolve: (result: ToolResult) => void;
  reject: (error: unknown) => void;
};

function toBrainTools(tools: ToolDefinition[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }
  }));
}

function resultContent(result: ToolResult): string {
  const value = result.ok
    ? result.value ?? null
    : { error: result.error ?? "Tool execution failed" };
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function splitForSpeech(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();

  while (remaining.length > TTS_CHUNK_CHARS) {
    let splitAt = remaining.lastIndexOf(" ", TTS_CHUNK_CHARS);
    if (splitAt < Math.floor(TTS_CHUNK_CHARS * 0.6)) {
      splitAt = TTS_CHUNK_CHARS;
    }
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

function concatAudio(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export class ChainedVoiceProvider implements VoiceProvider {
  readonly id: string;

  constructor(
    id: string,
    private readonly options: ChainedVoiceOptions
  ) {
    this.id = id;
  }

  async connect(options: VoiceConnectOptions = {}): Promise<VoiceSession> {
    return new ChainedVoiceSession(this.options, options.tools ?? []);
  }
}

class ChainedVoiceSession implements VoiceSession {
  private readonly handlers = new Set<VoiceEventHandler>();
  private readonly tools: unknown[];
  private readonly messages: BrainMessage[] = [];
  private readonly pendingTools = new Map<string, PendingTool>();
  private readonly audioChunks: Uint8Array[] = [];
  private readonly maxAudioBytes: number;
  private readonly maxHistoryMessages: number;
  private readonly maxToolRounds: number;
  private audioBytes = 0;
  private capturingSpeech = false;
  private activeController: AbortController | null = null;
  private activeTurn: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly options: ChainedVoiceOptions,
    tools: ToolDefinition[]
  ) {
    this.tools = toBrainTools(tools);
    this.maxAudioBytes =
      options.maxBufferedAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES;
    this.maxHistoryMessages =
      options.maxHistoryMessages ?? DEFAULT_MAX_HISTORY_MESSAGES;
    this.maxToolRounds =
      options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;

    if (options.systemInstruction?.trim()) {
      this.messages.push({
        role: "system",
        content: options.systemInstruction.trim()
      });
    }
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
        "Chained voice expects non-empty mono PCM16LE at 16 kHz"
      );
    }
    if (this.audioBytes + chunk.data.byteLength > this.maxAudioBytes) {
      this.clearAudio();
      throw new Error("Chained voice input exceeded the bounded turn size");
    }

    if (!this.capturingSpeech) {
      this.capturingSpeech = true;
      await this.emit({ type: "speech.started" });
    }

    const copy = Uint8Array.from(chunk.data);
    this.audioChunks.push(copy);
    this.audioBytes += copy.byteLength;
  }

  async endAudioStream(): Promise<void> {
    this.assertOpen();
    if (this.audioBytes === 0) return;

    const audio: AudioChunk = {
      format: "pcm16le",
      data: concatAudio(this.audioChunks, this.audioBytes),
      sampleRate: 16_000,
      channels: 1
    };
    this.clearAudio();

    if (this.capturingSpeech) {
      this.capturingSpeech = false;
      await this.emit({ type: "speech.stopped" });
    }

    this.startTurn({ audio });
  }

  async sendText(textInput: string): Promise<void> {
    this.assertOpen();
    const text = textInput.trim();
    if (!text) return;
    this.startTurn({ text });
  }

  async sendToolResult(result: ToolResult): Promise<void> {
    this.assertOpen();
    if (!result.callId) {
      throw new Error("Chained voice tool results require callId");
    }
    const pending = this.pendingTools.get(result.callId);
    if (!pending) {
      throw new Error(`No pending chained tool call ${result.callId}`);
    }
    pending.resolve(result);
  }

  async interrupt(): Promise<void> {
    if (this.closed) return;
    this.clearAudio();
    this.capturingSpeech = false;
    const cancellation = this.abortActive(
      new Error("Chained voice turn interrupted")
    );
    if (cancellation.callIds.length > 0) {
      await this.emit({
        type: "tool.cancel",
        callIds: cancellation.callIds
      });
    }
    if (cancellation.aborted) {
      await this.emit({ type: "interrupted" });
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearAudio();
    this.capturingSpeech = false;
    this.abortActive(new Error("Chained voice session closed"));
    await this.activeTurn?.catch(() => undefined);
    this.handlers.clear();
  }

  private startTurn(input: { audio?: AudioChunk; text?: string }): void {
    const cancellation = this.abortActive(
      new Error("Chained voice turn superseded")
    );
    if (cancellation.callIds.length > 0) {
      void this.emit({
        type: "tool.cancel",
        callIds: cancellation.callIds
      });
    }
    if (cancellation.aborted) {
      void this.emit({ type: "interrupted" });
    }

    const controller = new AbortController();
    this.activeController = controller;
    const task = this.runTurn(input, controller.signal)
      .catch(async (error) => {
        if (controller.signal.aborted || this.closed) return;
        await this.emit({
          type: "error",
          message:
            error instanceof Error
              ? error.message
              : "Chained voice turn failed"
        });
      })
      .finally(() => {
        if (this.activeController === controller) {
          this.activeController = null;
          this.activeTurn = null;
        }
      });
    this.activeTurn = task;
  }

  private async runTurn(
    input: { audio?: AudioChunk; text?: string },
    signal: AbortSignal
  ): Promise<void> {
    let userText = input.text?.trim() ?? "";

    if (input.audio) {
      userText = await this.options.stt.transcribe(input.audio, { signal });
      if (signal.aborted) return;
      if (!userText) return;
      await this.emit({
        type: "input.transcript",
        text: userText,
        final: true
      });
    }

    if (!userText) return;
    this.messages.push({ role: "user", content: userText });
    this.trimHistory();

    for (let round = 0; round < this.maxToolRounds; round += 1) {
      const response = await this.options.brain.complete({
        messages: this.messages.slice(),
        ...(this.tools.length > 0 ? { tools: this.tools } : {}),
        signal
      });
      if (signal.aborted) return;

      if (response.usage) {
        await this.emit({ type: "usage", usage: response.usage });
      }

      const toolCalls = response.toolCalls ?? [];
      if (toolCalls.length > 0) {
        this.messages.push({
          role: "assistant",
          content: response.text,
          toolCalls
        });

        const results = await Promise.all(
          toolCalls.map((call) => this.requestTool(call, signal))
        );
        if (signal.aborted) return;

        for (const result of results) {
          this.messages.push({
            role: "tool",
            name: result.name,
            toolCallId: result.callId!,
            content: resultContent(result)
          });
        }
        this.trimHistory();
        continue;
      }

      const answer = response.text.trim();
      this.messages.push({ role: "assistant", content: answer });
      this.trimHistory();
      if (!answer) return;

      await this.emit({ type: "output.started" });
      await this.emit({
        type: "output.transcript",
        text: answer,
        final: true
      });

      for (const part of splitForSpeech(answer)) {
        const audio = await this.options.tts.synthesize(part, { signal });
        if (signal.aborted) return;
        await this.emit({ type: "audio", chunk: audio });
      }

      if (!signal.aborted) {
        await this.emit({ type: "output.completed" });
      }
      return;
    }

    throw new Error("Chained voice exceeded the maximum tool-call rounds");
  }

  private async requestTool(
    call: BrainToolCall,
    signal: AbortSignal
  ): Promise<ToolResult> {
    if (this.pendingTools.has(call.id)) {
      throw new Error(`Duplicate chained tool call id: ${call.id}`);
    }
    if (signal.aborted) {
      throw signal.reason ?? new Error("Chained tool call cancelled");
    }

    let pending!: PendingTool;
    const resultPromise = new Promise<ToolResult>((resolve, reject) => {
      pending = { resolve, reject };
    });
    this.pendingTools.set(call.id, pending);

    const abort = () => {
      pending.reject(signal.reason ?? new Error("Chained tool call cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });

    try {
      await this.emit({
        type: "tool.call",
        name: call.name,
        arguments: call.arguments,
        callId: call.id
      });
      return await resultPromise;
    } finally {
      signal.removeEventListener("abort", abort);
      this.pendingTools.delete(call.id);
    }
  }

  private abortActive(reason: Error): {
    aborted: boolean;
    callIds: string[];
  } {
    const callIds = [...this.pendingTools.keys()];
    const controller = this.activeController;
    const aborted = Boolean(controller && !controller.signal.aborted);

    if (aborted) {
      controller!.abort(reason);
    }
    for (const pending of this.pendingTools.values()) {
      pending.reject(reason);
    }
    this.pendingTools.clear();

    return { aborted, callIds };
  }

  private clearAudio(): void {
    this.audioChunks.length = 0;
    this.audioBytes = 0;
  }

  private trimHistory(): void {
    if (this.messages.length <= this.maxHistoryMessages) return;

    const system =
      this.messages[0]?.role === "system" ? [this.messages[0]] : [];
    let tail = this.messages.slice(
      -(this.maxHistoryMessages - system.length)
    );
    while (tail[0]?.role === "tool") {
      tail = tail.slice(1);
    }

    this.messages.length = 0;
    this.messages.push(...system, ...tail);
  }

  private async emit(event: VoiceSessionEvent): Promise<void> {
    for (const handler of [...this.handlers]) {
      await handler(event);
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("Chained voice session is closed");
    }
  }
}
