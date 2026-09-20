import { afterEach, describe, expect, it } from "vitest";
import {
  createPrimaryVoiceProvider,
  createVoiceChain,
  createVoiceProvider
} from "../src/provider-registry.js";
import type { ProvidersConfig } from "../src/config/providers.js";

afterEach(() => {
  delete process.env.NARA_TEST_GEMINI_KEY;
  delete process.env.NARA_TEST_GEMINI_BACKUP_KEY;
});

describe("voice provider registry", () => {
  it("constructs Gemini Live from server-side configuration", () => {
    process.env.NARA_TEST_GEMINI_KEY = "test-secret";

    const provider = createVoiceProvider("gemini-live", {
      kind: "voice",
      adapter: "gemini-live",
      model: "gemini-3.8-live",
      api_key_env: "NARA_TEST_GEMINI_KEY",
      input_transcription: false,
      output_transcription: false
    });

    expect(provider.id).toBe("gemini-live");
  });

  it("fails early when the configured Gemini secret is absent", () => {
    expect(() =>
      createVoiceProvider("gemini-live", {
        kind: "voice",
        adapter: "gemini-live",
        model: "gemini-3.8-live",
        api_key_env: "NARA_TEST_GEMINI_KEY"
      })
    ).toThrow(/missing API key/);
  });

  it("resolves the configured primary voice provider", () => {
    process.env.NARA_TEST_GEMINI_KEY = "test-secret";

    const config = {
      voice: { primary: "gemini-live", fallbacks: [] },
      brain: { primary: "brain", fallbacks: [] },
      providers: {
        "gemini-live": {
          kind: "voice",
          adapter: "gemini-live",
          model: "gemini-3.8-live",
          api_key_env: "NARA_TEST_GEMINI_KEY"
        },
        brain: {
          kind: "brain",
          adapter: "openai-compatible",
          base_url: "http://localhost",
          model: "mock"
        }
      }
    } satisfies ProvidersConfig;

    expect(createPrimaryVoiceProvider(config).id).toBe("gemini-live");
    expect(createVoiceChain(config).id).toBe("gemini-live");
  });

  it("builds a lazy fallback route when multiple voice providers are configured", () => {
    process.env.NARA_TEST_GEMINI_KEY = "primary-secret";
    process.env.NARA_TEST_GEMINI_BACKUP_KEY = "backup-secret";

    const config = {
      voice: {
        primary: "gemini-primary",
        fallbacks: ["gemini-backup"]
      },
      brain: { primary: "brain", fallbacks: [] },
      providers: {
        "gemini-primary": {
          kind: "voice",
          adapter: "gemini-live",
          model: "gemini-3.8-live",
          api_key_env: "NARA_TEST_GEMINI_KEY"
        },
        "gemini-backup": {
          kind: "voice",
          adapter: "gemini-live",
          model: "gemini-3.8-live",
          api_key_env: "NARA_TEST_GEMINI_BACKUP_KEY"
        },
        brain: {
          kind: "brain",
          adapter: "openai-compatible",
          base_url: "http://localhost",
          model: "mock"
        }
      }
    } satisfies ProvidersConfig;

    expect(createVoiceChain(config).id).toBe("voice-fallback");
  });

  it("rejects duplicate voice provider IDs in one route", () => {
    process.env.NARA_TEST_GEMINI_KEY = "test-secret";

    const config = {
      voice: {
        primary: "gemini-live",
        fallbacks: ["gemini-live"]
      },
      brain: { primary: "brain", fallbacks: [] },
      providers: {
        "gemini-live": {
          kind: "voice",
          adapter: "gemini-live",
          model: "gemini-3.8-live",
          api_key_env: "NARA_TEST_GEMINI_KEY"
        },
        brain: {
          kind: "brain",
          adapter: "openai-compatible",
          base_url: "http://localhost",
          model: "mock"
        }
      }
    } satisfies ProvidersConfig;

    expect(() => createVoiceChain(config)).toThrow(/duplicate provider IDs/);
  });
});
