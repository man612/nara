export type AudioChunk = {
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

export type BrainResponse = {
  text: string;
  toolCalls?: unknown[];
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

export interface VoiceSession {
  sendAudio(chunk: AudioChunk): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export interface VoiceProvider {
  readonly id: string;
  connect(): Promise<VoiceSession>;
}
