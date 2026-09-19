import { describe, expect, it } from "vitest";
import type {
  BrainProvider,
  BrainRequest,
  BrainResponse
} from "../src/contracts/providers.js";
import { FallbackBrainProvider } from "../src/providers/brain/fallback.js";

class FakeBrain implements BrainProvider {
  constructor(
    readonly id: string,
    private readonly behavior: "fail" | "ok"
  ) {}

  async complete(_request: BrainRequest): Promise<BrainResponse> {
    if (this.behavior === "fail") throw new Error("offline");
    return { text: this.id };
  }
}

describe("FallbackBrainProvider", () => {
  it("uses the first healthy provider", async () => {
    const brain = new FallbackBrainProvider("brain", [
      new FakeBrain("primary", "fail"),
      new FakeBrain("secondary", "ok")
    ]);

    const result = await brain.complete({ messages: [] });
    expect(result.text).toBe("secondary");
  });

  it("reports all failures", async () => {
    const brain = new FallbackBrainProvider("brain", [
      new FakeBrain("a", "fail"),
      new FakeBrain("b", "fail")
    ]);

    await expect(brain.complete({ messages: [] })).rejects.toThrow("a: offline");
  });
});
