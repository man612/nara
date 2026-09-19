import type {
  BrainProvider,
  VoiceProvider
} from "./contracts/providers.js";
import type { ProviderDefinition, ProvidersConfig } from "./config/providers.js";
import { FallbackBrainProvider } from "./providers/brain/fallback.js";
import { OpenAICompatibleBrain } from "./providers/brain/openai-compatible.js";
import { GeminiLiveVoiceProvider } from "./providers/voice/gemini-live.js";

function providerApiKey(
  id: string,
  definition: ProviderDefinition
): string | undefined {
  return definition.api_key_env
    ? process.env[definition.api_key_env]
    : undefined;
}

function createBrainProvider(id: string, definition: ProviderDefinition): BrainProvider {
  if (definition.kind !== "brain") {
    throw new Error(`Provider ${id} is not a brain provider`);
  }

  if (definition.adapter === "openai-compatible") {
    if (!definition.base_url) throw new Error(`Provider ${id} is missing base_url`);
    if (!definition.model) throw new Error(`Provider ${id} is missing model`);

    const apiKey = providerApiKey(id, definition);

    return new OpenAICompatibleBrain({
      id,
      baseUrl: definition.base_url,
      model: definition.model,
      ...(apiKey ? { apiKey } : {})
    });
  }

  throw new Error(`Unsupported brain adapter: ${definition.adapter}`);
}

export function createVoiceProvider(
  id: string,
  definition: ProviderDefinition
): VoiceProvider {
  if (definition.kind !== "voice") {
    throw new Error(`Provider ${id} is not a voice provider`);
  }

  if (definition.adapter === "gemini-live") {
    if (!definition.model) throw new Error(`Provider ${id} is missing model`);
    const apiKey = providerApiKey(id, definition);
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

  throw new Error(`Unsupported voice adapter: ${definition.adapter}`);
}

export function createPrimaryVoiceProvider(
  config: ProvidersConfig
): VoiceProvider {
  const id = config.voice.primary;
  const definition = config.providers[id];
  if (!definition) throw new Error(`Unknown provider: ${id}`);
  return createVoiceProvider(id, definition);
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
