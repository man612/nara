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
  delete process.env.NARA_TEST_OPENAI_KEY;
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

  it("constructs GPT-Live with a delegated Responses backend", () => {
    process.env.NARA_TEST_OPENAI_KEY = "openai-secret";

    const provider = createVoiceProvider("openai-live", {
      kind: "voice",
      adapter: "openai-live",
      model: "gpt-live-1",
      backend_model: "gpt-5.6-luna",
      voice: "marin",
      api_key_env: "NARA_TEST_OPENAI_KEY",
      system_instruction: "Be concise.",
      backend_instructions: "Use Nara tools when needed."
    });

    expect(provider.id).toBe("openai-live");
  });

  it("fails early when GPT-Live credentials or backend model are missing", () => {
    expect(() =>
      createVoiceProvider("openai-live", {
        kind: "voice",
        adapter: "openai-live",
        model: "gpt-live-1",
        backend_model: "gpt-5.6-luna",
        api_key_env: "NARA_TEST_OPENAI_KEY"
      })
    ).toThrow(/missing API key/);

    process.env.NARA_TEST_OPENAI_KEY = "openai-secret";
    expect(() =>
      createVoiceProvider("openai-live", {
        kind: "voice",
        adapter: "openai-live",
        model: "gpt-live-1",
        api_key_env: "NARA_TEST_OPENAI_KEY"
      })
    ).toThrow(/missing backend_model/);
  });

  it("constructs the chained STT -> brain -> TTS route", () => {
    const config = {
      voice: {
        primary: "chained",
        fallbacks: []
      },
      brain: {
        primary: "brain",
        fallbacks: []
      },
      providers: {
        chained: {
          kind: "voice",
          adapter: "chained",
          stt_provider: "stt",
          tts_provider: "tts",
          system_instruction: "Be concise."
        },
        stt: {
          kind: "stt",
          adapter: "openai-compatible",
          base_url: "http://localhost:8001/v1",
          model: "whisper"
        },
        tts: {
          kind: "tts",
          adapter: "openai-compatible",
          base_url: "http://localhost:8002/v1",
          model: "tts",
          voice: "local",
          sample_rate: 24000
        },
        brain: {
          kind: "brain",
          adapter: "openai-compatible",
          base_url: "http://localhost:8003/v1",
          model: "brain"
        }
      }
    } satisfies ProvidersConfig;

    expect(createVoiceChain(config).id).toBe("chained");
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
