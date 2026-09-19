import { describe, expect, it } from "vitest";
import { normalizeOpenAICompatibleUsage } from "../src/providers/brain/openai-compatible.js";

describe("OpenAI-compatible usage normalization", () => {
  it("normalizes DeepSeek cache accounting", () => {
    expect(
      normalizeOpenAICompatibleUsage({
        prompt_tokens: 1200,
        completion_tokens: 80,
        total_tokens: 1280,
        prompt_cache_hit_tokens: 1000,
        prompt_cache_miss_tokens: 200
      })
    ).toEqual({
      inputTokens: 1200,
      outputTokens: 80,
      totalTokens: 1280,
      cachedInputTokens: 1000,
      uncachedInputTokens: 200
    });
  });

  it("derives uncached tokens from generic cached token details", () => {
    expect(
      normalizeOpenAICompatibleUsage({
        prompt_tokens: 500,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 320 }
      })
    ).toEqual({
      inputTokens: 500,
      outputTokens: 50,
      totalTokens: 550,
      cachedInputTokens: 320,
      uncachedInputTokens: 180
    });
  });

  it("returns undefined when no token usage exists", () => {
    expect(normalizeOpenAICompatibleUsage({})).toBeUndefined();
  });
});
