import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";

const routeSchema = z.object({
  primary: z.string(),
  fallbacks: z.array(z.string()).default([])
});

const providerSchema = z.object({
  kind: z.string(),
  adapter: z.string(),
  model: z.string().optional(),
  backend_model: z.string().optional(),
  backend_instructions: z.string().optional(),
  base_url: z.string().optional(),
  api_key_env: z.string().optional(),
  timeout_ms: z.number().int().min(250).max(120_000).optional(),
  stt_provider: z.string().optional(),
  tts_provider: z.string().optional(),
  voice: z.string().optional(),
  language: z.string().optional(),
  sample_rate: z.number().int().min(8_000).max(192_000).optional(),
  system_instruction: z.string().optional()
}).passthrough();

const configSchema = z.object({
  voice: routeSchema,
  brain: routeSchema,
  search: routeSchema.optional(),
  memory: z.object({ primary: z.string() }).optional(),
  providers: z.record(z.string(), providerSchema)
});

export type ProvidersConfig = z.infer<typeof configSchema>;
export type ProviderDefinition = z.infer<typeof providerSchema>;

export function interpolateEnvironment(source: string): string {
  return source.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_match, name: string, fallback?: string) => {
    const value = process.env[name];
    if (value !== undefined && value !== "") return value;
    return fallback ?? "";
  });
}

export async function loadProvidersConfig(path: string): Promise<ProvidersConfig> {
  const raw = await readFile(path, "utf8");
  const expanded = interpolateEnvironment(raw);
  return configSchema.parse(parse(expanded));
}
