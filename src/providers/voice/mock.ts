import type { AudioChunk, VoiceProvider, VoiceSession } from "../../contracts/providers.js";

class MockVoiceSession implements VoiceSession {
  async sendAudio(_chunk: AudioChunk): Promise<void> {}
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {}
}

export class MockVoiceProvider implements VoiceProvider {
  readonly id = "mock";
  async connect(): Promise<VoiceSession> {
    return new MockVoiceSession();
  }
}
