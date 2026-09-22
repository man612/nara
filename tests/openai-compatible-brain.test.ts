import { describe, expect, it } from "vitest";
import type { BrainProvider } from "../src/contracts/providers.js";
import { FallbackBrainProvider } from "../src/providers/brain/fallback.js";
import { OpenAICompatibleBrain } from "../src/providers/brain/openai-compatible.js";

const request = {
  messages: [{ role: "user" as const, content: "hello" }]
};

describe("OpenAICompatibleBrain resilience", () => {
  it("times out a hung primary so fallback can continue", async () => {
    let primaryAborted = false;
    const primary = new OpenAICompatibleBrain({
      id: "primary",
      baseUrl: "https://primary.invalid",
      model: "test",
      timeoutMs: 25,
      fetchImpl: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("missing timeout signal"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              primaryAborted = true;
              reject(signal.reason);
            },
            { once: true }
          );
        })
    });
    const secondary: BrainProvider = {
      id: "secondary",
      async complete() {
        return { text: "fallback ok" };
      }
    };
    const chain = new FallbackBrainProvider("brain-fallback", [
      primary,
      secondary
    ]);

    await expect(chain.complete(request)).resolves.toMatchObject({
      text: "fallback ok",
      providerId: "secondary"
    });
    expect(primaryAborted).toBe(true);
  });

  it("passes configured requests through before the deadline", async () => {
    const brain = new OpenAICompatibleBrain({
      id: "fast",
      baseUrl: "https://fast.invalid/",
      model: "test",
      timeoutMs: 1000,
      fetchImpl: async (_input, init) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return Response.json({
          choices: [{ message: { content: "ok" } }]
        });
      }
    });

    await expect(brain.complete(request)).resolves.toMatchObject({
      text: "ok",
      providerId: "fast"
    });
  });
});
