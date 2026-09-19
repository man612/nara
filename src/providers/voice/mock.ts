import type {
  AudioChunk,
  VoiceEventHandler,
  VoiceProvider,
  VoiceSession
} from "../../contracts/providers.js";

class MockVoiceSession implements VoiceSession {
  private readonly handlers = new Set<VoiceEventHandler>();

  async sendAudio(_chunk: AudioChunk): Promise<void> {}

  async interrupt(): Promise<void> {
    await this.emit({ type: "interrupted" });
  }

  subscribe(handler: VoiceEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async close(): Promise<void> {
    this.handlers.clear();
  }

  async emit(event: Parameters<VoiceEventHandler>[0]): Promise<void> {
    for (const handler of this.handlers) await handler(event);
  }
}

export class MockVoiceProvider implements VoiceProvider {
  readonly id = "mock";

  async connect(): Promise<VoiceSession> {
    return new MockVoiceSession();
  }
}
