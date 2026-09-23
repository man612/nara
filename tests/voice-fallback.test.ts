import { describe, expect, it } from "vitest";
import type { ToolResult } from "../src/actions/contracts.js";
import type {
  AudioChunk,
  VoiceEventHandler,
  VoiceProvider,
  VoiceSession,
  VoiceSessionEvent
} from "../src/contracts/providers.js";
import { FallbackVoiceProvider } from "../src/providers/voice/fallback.js";

class FakeVoiceSession implements VoiceSession {
  readonly audio: AudioChunk[] = [];
  readonly texts: string[] = [];
  readonly toolResults: ToolResult[] = [];
  readonly handlers = new Set<VoiceEventHandler>();
  interrupts = 0;
  closes = 0;

  async sendAudio(chunk: AudioChunk): Promise<void> {
    this.audio.push(chunk);
  }

  async sendText(text: string): Promise<void> {
    this.texts.push(text);
  }

  async sendToolResult(result: ToolResult): Promise<void> {
    this.toolResults.push(result);
  }

  async interrupt(): Promise<void> {
    this.interrupts += 1;
  }

  subscribe(handler: VoiceEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async close(): Promise<void> {
    this.closes += 1;
  }

  async emit(event: VoiceSessionEvent): Promise<void> {
    for (const handler of [...this.handlers]) {
      await handler(event);
    }
  }
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

const audio: AudioChunk = {
  format: "pcm16le",
  data: Uint8Array.from([1, 0]),
  sampleRate: 16_000,
  channels: 1
};

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

    const connected = await provider.connect();
    expect(attempted).toEqual(["primary", "secondary"]);
    await connected.close();
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

  it("recovers on the next user input without replaying prior audio", async () => {
    const primary = new FakeVoiceSession();
    const secondary = new FakeVoiceSession();
    const attempts: string[] = [];
    const provider = new FallbackVoiceProvider("voice-fallback", [
      {
        id: "primary",
        create: () =>
          new FakeVoiceProvider("primary", async () => {
            attempts.push("primary");
            return primary;
          })
      },
      {
        id: "secondary",
        create: () =>
          new FakeVoiceProvider("secondary", async () => {
            attempts.push("secondary");
            return secondary;
          })
      }
    ]);

    const session = await provider.connect();
    const events: VoiceSessionEvent[] = [];
    session.subscribe((event) => {
      events.push(event);
    });

    await session.sendAudio(audio);
    await primary.emit({
      type: "session.disconnected",
      providerId: "primary",
      reason: "socket lost",
      recoverable: true
    });

    expect(attempts).toEqual(["primary"]);
    expect(secondary.audio).toHaveLength(0);

    await session.sendAudio(audio);

    expect(attempts).toEqual(["primary", "secondary"]);
    expect(primary.audio).toHaveLength(1);
    expect(secondary.audio).toHaveLength(1);
    expect(events).toContainEqual({
      type: "session.recovered",
      fromProviderId: "primary",
      toProviderId: "secondary"
    });

    await session.close();
  });

  it("cancels tool work and stale playback from the dead provider", async () => {
    const primary = new FakeVoiceSession();
    const secondary = new FakeVoiceSession();
    const provider = new FallbackVoiceProvider("voice-fallback", [
      {
        id: "primary",
        create: () =>
          new FakeVoiceProvider("primary", async () => primary)
      },
      {
        id: "secondary",
        create: () =>
          new FakeVoiceProvider("secondary", async () => secondary)
      }
    ]);
    const session = await provider.connect();
    const events: VoiceSessionEvent[] = [];
    session.subscribe((event) => {
      events.push(event);
    });

    await primary.emit({ type: "output.started" });
    await primary.emit({
      type: "tool.call",
      name: "web_search",
      arguments: { query: "status" },
      callId: "call-old"
    });
    await primary.emit({
      type: "session.disconnected",
      providerId: "primary",
      reason: "socket lost",
      recoverable: true
    });

    expect(events).toContainEqual({
      type: "tool.cancel",
      callIds: ["call-old"]
    });
    expect(events).toContainEqual({ type: "interrupted" });

    await session.sendAudio(audio);
    await primary.emit({
      type: "audio",
      chunk: audio
    });

    expect(
      events.filter((event) => event.type === "audio")
    ).toHaveLength(0);

    await session.close();
  });

  it("prefers the next provider after native recovery fails, then wraps around", async () => {
    const primary1 = new FakeVoiceSession();
    const primary2 = new FakeVoiceSession();
    const attempts: string[] = [];
    let primaryConnects = 0;

    const provider = new FallbackVoiceProvider("voice-fallback", [
      {
        id: "primary",
        create: () =>
          new FakeVoiceProvider("primary", async () => {
            attempts.push("primary");
            primaryConnects += 1;
            return primaryConnects === 1 ? primary1 : primary2;
          })
      },
      {
        id: "secondary",
        create: () =>
          new FakeVoiceProvider("secondary", async () => {
            attempts.push("secondary");
            throw new Error("secondary unavailable");
          })
      }
    ]);

    const session = await provider.connect();
    await primary1.emit({
      type: "session.disconnected",
      providerId: "primary",
      reason: "native reconnect failed",
      recoverable: true
    });

    await session.sendAudio(audio);

    expect(attempts).toEqual([
      "primary",
      "secondary",
      "primary"
    ]);
    expect(primary2.audio).toHaveLength(1);
    await session.close();
  });

  it("does not auto-recover a non-recoverable provider termination", async () => {
    const primary = new FakeVoiceSession();
    let secondaryConnects = 0;
    const provider = new FallbackVoiceProvider("voice-fallback", [
      {
        id: "primary",
        create: () =>
          new FakeVoiceProvider("primary", async () => primary)
      },
      {
        id: "secondary",
        create: () =>
          new FakeVoiceProvider("secondary", async () => {
            secondaryConnects += 1;
            return new FakeVoiceSession();
          })
      }
    ]);

    const session = await provider.connect();
    await primary.emit({
      type: "session.disconnected",
      providerId: "primary",
      reason: "content",
      recoverable: false
    });

    await expect(session.sendAudio(audio)).rejects.toThrow(
      /not safely recoverable/
    );
    expect(secondaryConnects).toBe(0);
    await session.close();
  });
});
