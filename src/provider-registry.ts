import type {
  BrainProvider,
  SearchProvider,
  SpeechToTextProvider,
  TextToSpeechProvider,
  VoiceProvider
} from "./contracts/providers.js";
import type { ProviderDefinition, ProvidersConfig } from "./config/providers.js";
import { FallbackBrainProvider } from "./providers/brain/fallback.js";
import { OpenAICompatibleBrain } from "./providers/brain/openai-compatible.js";
import { FallbackSearchProvider } from "./providers/search/fallback.js";
import { SearxngSearchProvider } from "./providers/search/searxng.js";
import { OpenAICompatibleStt } from "./providers/stt/openai-compatible.js";
import { OpenAICompatibleTts } from "./providers/tts/openai-compatible.js";
import { ChainedVoiceProvider } from "./providers/voice/chained.js";
import { FallbackVoiceProvider } from "./providers/voice/fallback.js";
import { GeminiLiveVoiceProvider } from "./providers/voice/gemini-live.js";
import { OpenAILiveVoiceProvider } from "./providers/voice/openai-live.js";

function providerApiKey(
  definition: ProviderDefinition
): string | undefined {
  return definition.api_key_env
    ? process.env[definition.api_key_env]
    : undefined;
}

function createBrainProvider(
  id: string,
  definition: ProviderDefinition
): BrainProvider {
  if (definition.kind !== "brain") {
    throw new Error(`Provider ${id} is not a brain provider`);
  }

  if (definition.adapter === "openai-compatible") {
    if (!definition.base_url) {
      throw new Error(`Provider ${id} is missing base_url`);
    }
    if (!definition.model) {
      throw new Error(`Provider ${id} is missing model`);
    }

    const apiKey = providerApiKey(definition);

    return new OpenAICompatibleBrain({
      id,
      baseUrl: definition.base_url,
      model: definition.model,
      ...(apiKey ? { apiKey } : {}),
      ...(definition.timeout_ms !== undefined
        ? { timeoutMs: definition.timeout_ms }
        : {})
    });
  }

  throw new Error(`Unsupported brain adapter: ${definition.adapter}`);
}

function createSpeechToTextProvider(
  id: string,
  definition: ProviderDefinition
): SpeechToTextProvider {
  if (definition.kind !== "stt") {
    throw new Error(`Provider ${id} is not an STT provider`);
  }
  if (definition.adapter !== "openai-compatible") {
    throw new Error(`Unsupported STT adapter: ${definition.adapter}`);
  }
  if (!definition.base_url) {
    throw new Error(`Provider ${id} is missing base_url`);
  }
  if (!definition.model) {
    throw new Error(`Provider ${id} is missing model`);
  }

  const apiKey = providerApiKey(definition);
  if (definition.api_key_env && !apiKey) {
    throw new Error(
      `Provider ${id} is missing API key from ${definition.api_key_env}`
    );
  }

  return new OpenAICompatibleStt({
    id,
    baseUrl: definition.base_url,
    model: definition.model,
    ...(apiKey ? { apiKey } : {}),
    ...(definition.language ? { language: definition.language } : {}),
    ...(definition.timeout_ms !== undefined
      ? { timeoutMs: definition.timeout_ms }
      : {})
  });
}

function createTextToSpeechProvider(
  id: string,
  definition: ProviderDefinition
): TextToSpeechProvider {
  if (definition.kind !== "tts") {
    throw new Error(`Provider ${id} is not a TTS provider`);
  }
  if (definition.adapter !== "openai-compatible") {
    throw new Error(`Unsupported TTS adapter: ${definition.adapter}`);
  }
  if (!definition.base_url) {
    throw new Error(`Provider ${id} is missing base_url`);
  }
  if (!definition.model) {
    throw new Error(`Provider ${id} is missing model`);
  }
  if (!definition.voice) {
    throw new Error(`Provider ${id} is missing voice`);
  }

  const apiKey = providerApiKey(definition);
  if (definition.api_key_env && !apiKey) {
    throw new Error(
      `Provider ${id} is missing API key from ${definition.api_key_env}`
    );
  }

  return new OpenAICompatibleTts({
    id,
    baseUrl: definition.base_url,
    model: definition.model,
    voice: definition.voice,
    ...(apiKey ? { apiKey } : {}),
    ...(definition.sample_rate !== undefined
      ? { sampleRate: definition.sample_rate }
      : {}),
    ...(definition.timeout_ms !== undefined
      ? { timeoutMs: definition.timeout_ms }
      : {})
  });
}

export function createVoiceProvider(
  id: string,
  definition: ProviderDefinition,
  config?: ProvidersConfig
): VoiceProvider {
  if (definition.kind !== "voice") {
    throw new Error(`Provider ${id} is not a voice provider`);
  }

  if (definition.adapter === "gemini-live") {
    if (!definition.model) {
      throw new Error(`Provider ${id} is missing model`);
    }
    const apiKey = providerApiKey(definition);
    if (!apiKey) {
      throw new Error(
        `Provider ${id} is missing API key from ${definition.api_key_env ?? "api_key_env"}`
      );
    }

    return new GeminiLiveVoiceProvider(id, {
      apiKey,
      model: definition.model,
      inputTranscription: definition.input_transcription === true,
      outputTranscription: definition.output_transcription === true
    });
  }

  if (definition.adapter === "openai-live") {
    if (!definition.model) {
      throw new Error(`Provider ${id} is missing model`);
    }
    if (!definition.backend_model) {
      throw new Error(`Provider ${id} is missing backend_model`);
    }
    const apiKey = providerApiKey(definition);
    if (!apiKey) {
      throw new Error(
        `Provider ${id} is missing API key from ${definition.api_key_env ?? "api_key_env"}`
      );
    }

    return new OpenAILiveVoiceProvider(id, {
      apiKey,
      model: definition.model,
      backendModel: definition.backend_model,
      ...(definition.voice ? { voice: definition.voice } : {}),
      ...(definition.system_instruction
        ? { systemInstruction: definition.system_instruction }
        : {}),
      ...(definition.backend_instructions
        ? { backendInstructions: definition.backend_instructions }
        : {})
    });
  }

  if (definition.adapter === "chained") {
    if (!config) {
      throw new Error(
        `Provider ${id} needs full provider config for chained voice`
      );
    }
    if (!definition.stt_provider) {
      throw new Error(`Provider ${id} is missing stt_provider`);
    }
    if (!definition.tts_provider) {
      throw new Error(`Provider ${id} is missing tts_provider`);
    }

    const sttDefinition = config.providers[definition.stt_provider];
    if (!sttDefinition) {
      throw new Error(`Unknown provider: ${definition.stt_provider}`);
    }
    const ttsDefinition = config.providers[definition.tts_provider];
    if (!ttsDefinition) {
      throw new Error(`Unknown provider: ${definition.tts_provider}`);
    }

    return new ChainedVoiceProvider(id, {
      stt: createSpeechToTextProvider(
        definition.stt_provider,
        sttDefinition
      ),
      brain: createBrainChain(config),
      tts: createTextToSpeechProvider(
        definition.tts_provider,
        ttsDefinition
      ),
      ...(definition.system_instruction
        ? { systemInstruction: definition.system_instruction }
        : {})
    });
  }

  throw new Error(`Unsupported voice adapter: ${definition.adapter}`);
}

export function createSearchProvider(
  id: string,
  definition: ProviderDefinition
): SearchProvider {
  if (definition.kind !== "search") {
    throw new Error(`Provider ${id} is not a search provider`);
  }

  if (definition.adapter === "searxng") {
    if (!definition.base_url) {
      throw new Error(`Provider ${id} is missing base_url`);
    }
    return new SearxngSearchProvider(id, {
      baseUrl: definition.base_url,
      ...(definition.timeout_ms !== undefined
        ? { timeoutMs: definition.timeout_ms }
        : {})
    });
  }

  throw new Error(`Unsupported search adapter: ${definition.adapter}`);
}

export function createSearchChain(
  config: ProvidersConfig
): SearchProvider | undefined {
  if (!config.search) return undefined;

  const ids = [config.search.primary, ...config.search.fallbacks];
  if (new Set(ids).size !== ids.length) {
    throw new Error("Search provider route contains duplicate provider IDs");
  }

  const providers = ids.map((id) => {
    const definition = config.providers[id];
    if (!definition) throw new Error(`Unknown provider: ${id}`);
    return createSearchProvider(id, definition);
  });

  return providers.length === 1
    ? providers[0]!
    : new FallbackSearchProvider("search-fallback", providers);
}

export function createPrimaryVoiceProvider(
  config: ProvidersConfig
): VoiceProvider {
  const id = config.voice.primary;
  const definition = config.providers[id];
  if (!definition) throw new Error(`Unknown provider: ${id}`);
  return createVoiceProvider(id, definition, config);
}

export function createVoiceChain(config: ProvidersConfig): VoiceProvider {
  const ids = [config.voice.primary, ...config.voice.fallbacks];

  if (new Set(ids).size !== ids.length) {
    throw new Error("Voice provider route contains duplicate provider IDs");
  }

  const candidates = ids.map((id) => {
    const definition = config.providers[id];
    if (!definition) throw new Error(`Unknown provider: ${id}`);
    if (definition.kind !== "voice") {
      throw new Error(`Provider ${id} is not a voice provider`);
    }

    return {
      id,
      create: () => createVoiceProvider(id, definition, config)
    };
  });

  return candidates.length === 1
    ? candidates[0]!.create()
    : new FallbackVoiceProvider("voice-fallback", candidates);
}

export function createBrainChain(config: ProvidersConfig): BrainProvider {
  const ids = [config.brain.primary, ...config.brain.fallbacks];
  const providers = ids.map((id) => {
    const definition = config.providers[id];
    if (!definition) throw new Error(`Unknown provider: ${id}`);
    return createBrainProvider(id, definition);
  });

  return providers.length === 1
    ? providers[0]!
    : new FallbackBrainProvider("brain-fallback", providers);
}
