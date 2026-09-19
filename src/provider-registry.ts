import type { BrainProvider } from "./contracts/providers.js";
import type { ProviderDefinition, ProvidersConfig } from "./config/providers.js";
import { FallbackBrainProvider } from "./providers/brain/fallback.js";
import { OpenAICompatibleBrain } from "./providers/brain/openai-compatible.js";

function createBrainProvider(id: string, definition: ProviderDefinition): BrainProvider {
  if (definition.kind !== "brain") {
    throw new Error(`Provider ${id} is not a brain provider`);
  }

  if (definition.adapter === "openai-compatible") {
    if (!definition.base_url) throw new Error(`Provider ${id} is missing base_url`);
    if (!definition.model) throw new Error(`Provider ${id} is missing model`);

    const apiKey = definition.api_key_env
      ? process.env[definition.api_key_env]
      : undefined;

    return new OpenAICompatibleBrain({
      id,
      baseUrl: definition.base_url,
      model: definition.model,
      ...(apiKey ? { apiKey } : {})
    });
  }

  throw new Error(`Unsupported brain adapter: ${definition.adapter}`);
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
