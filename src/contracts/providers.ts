import type {
  ToolDefinition,
  ToolResult
} from "../actions/contracts.js";

export type AudioChunk = {
  format: "pcm16le";
  data: Uint8Array;
  sampleRate: number;
  channels: 1 | 2;
};

export type BrainMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type BrainRequest = {
  messages: BrainMessage[];
  tools?: unknown[];
};

export type ProviderUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  uncachedInputTokens?: number;
};

export type BrainResponse = {
  text: string;
  toolCalls?: unknown[];
  providerId?: string;
  usage?: ProviderUsage;
};

export interface BrainProvider {
  readonly id: string;
  complete(request: BrainRequest): Promise<BrainResponse>;
}

export interface SearchProvider {
  readonly id: string;
  search(query: string): Promise<Array<{ title: string; url: string; snippet?: string }>>;
}

export interface MemoryProvider {
  readonly id: string;
  remember(namespace: string, text: string): Promise<void>;
  recall(namespace: string, query: string, limit?: number): Promise<string[]>;
}

export type VoiceSessionEvent =
  | { type: "audio"; chunk: AudioChunk }
  | { type: "input.transcript"; text: string; final: boolean }
  | { type: "output.transcript"; text: string; final: boolean }
  | { type: "output.started" }
  | { type: "output.completed" }
  | { type: "speech.started" }
  | { type: "speech.stopped" }
  | { type: "interrupted" }
  | { type: "tool.call"; name: string; arguments: unknown; callId?: string }
  | { type: "tool.cancel"; callIds: string[] }
  | { type: "usage"; usage: ProviderUsage }
  | { type: "error"; message: string };

export type VoiceEventHandler = (event: VoiceSessionEvent) => void | Promise<void>;

export type VoiceConnectOptions = {
  tools?: ToolDefinition[];
};

export interface VoiceSession {
  sendAudio(chunk: AudioChunk): Promise<void>;
  sendText?(text: string): Promise<void>;
  sendToolResult?(result: ToolResult): Promise<void>;
  /**
   * Signal that microphone audio has paused/ended while keeping the realtime
   * session itself open. Providers that use automatic VAD can use this to
   * finalize a manually stopped utterance without closing the conversation.
   */
  endAudioStream?(): Promise<void>;
  interrupt(): Promise<void>;
  subscribe(handler: VoiceEventHandler): () => void;
  close(): Promise<void>;
}

export interface VoiceProvider {
  readonly id: string;
  connect(options?: VoiceConnectOptions): Promise<VoiceSession>;
}
