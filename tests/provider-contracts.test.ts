import { describe, expect, it } from "vitest";
import { MockVoiceProvider } from "../src/providers/voice/mock.js";

describe("provider contracts", () => {
  it("can create a mock voice session", async () => {
    const provider = new MockVoiceProvider();
    const session = await provider.connect();
    expect(provider.id).toBe("mock");
    await session.close();
  });
});
