import { describe, expect, it } from "vitest";
import type {
  VoiceEventHandler,
  VoiceProvider,
  VoiceSession
} from "../src/contracts/providers.js";
import { FallbackVoiceProvider } from "../src/providers/voice/fallback.js";

class FakeVoiceSession implements VoiceSession {
  async sendAudio(): Promise<void> {}
  async interrupt(): Promise<void> {}
  subscribe(_handler: VoiceEventHandler): () => void {
    return () => undefined;
  }
  async close(): Promise<void> {}
}

class FakeVoiceProvider implements VoiceProvider {
  constructor(
    readonly id: string,
    private readonly connectImpl: () => Promise<VoiceSession>
  ) {}

  connect(): Promise<VoiceSession> {
    return this.connectImpl();
  }
}

describe("FallbackVoiceProvider", () => {
  it("connects to the next provider when the primary cannot connect", async () => {
    const session = new FakeVoiceSession();
    const attempted: string[] = [];
    const provider = new FallbackVoiceProvider("voice-fallback", [
      {
        id: "primary",
        create: () =>
          new FakeVoiceProvider("primary", async () => {
            attempted.push("primary");
            throw new Error("unavailable");
          })
      },
      {
        id: "secondary",
        create: () =>
          new FakeVoiceProvider("secondary", async () => {
            attempted.push("secondary");
            return session;
          })
      }
    ]);

    await expect(provider.connect()).resolves.toBe(session);
    expect(attempted).toEqual(["primary", "secondary"]);
  });

  it("includes every candidate failure when no provider can connect", async () => {
    const provider = new FallbackVoiceProvider("voice-fallback", [
      {
        id: "one",
        create: () =>
          new FakeVoiceProvider("one", async () => {
            throw new Error("first failure");
          })
      },
      {
        id: "two",
        create: () => {
          throw new Error("second failure");
        }
      }
    ]);

    await expect(provider.connect()).rejects.toThrow(
      "All voice providers failed: one: first failure | two: second failure"
    );
  });
});
