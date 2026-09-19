import type {
  BrainProvider,
  BrainRequest,
  BrainResponse,
  ProviderUsage
} from "../../contracts/providers.js";

export type OpenAICompatibleConfig = {
  id: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
};

type UsageLike = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
};

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function normalizeOpenAICompatibleUsage(value: unknown): ProviderUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = value as UsageLike;

  const inputTokens =
    finiteNumber(usage.prompt_tokens) ?? finiteNumber(usage.input_tokens);
  const outputTokens =
    finiteNumber(usage.completion_tokens) ?? finiteNumber(usage.output_tokens);
  const cachedInputTokens =
    finiteNumber(usage.prompt_cache_hit_tokens) ??
    finiteNumber(usage.prompt_tokens_details?.cached_tokens);
  const uncachedInputTokens =
    finiteNumber(usage.prompt_cache_miss_tokens) ??
    (inputTokens !== undefined && cachedInputTokens !== undefined
      ? Math.max(0, inputTokens - cachedInputTokens)
      : undefined);
  const totalTokens =
    finiteNumber(usage.total_tokens) ??
    (inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined);

  const normalized: ProviderUsage = {};
  if (inputTokens !== undefined) normalized.inputTokens = inputTokens;
  if (outputTokens !== undefined) normalized.outputTokens = outputTokens;
  if (totalTokens !== undefined) normalized.totalTokens = totalTokens;
  if (cachedInputTokens !== undefined) normalized.cachedInputTokens = cachedInputTokens;
  if (uncachedInputTokens !== undefined) normalized.uncachedInputTokens = uncachedInputTokens;

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export class OpenAICompatibleBrain implements BrainProvider {
  readonly id: string;

  constructor(private readonly config: OpenAICompatibleConfig) {
    this.id = config.id;
  }

  async complete(request: BrainRequest): Promise<BrainResponse> {
    const baseUrl = this.config.baseUrl.replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: request.messages,
        ...(request.tools ? { tools: request.tools } : {})
      })
    });

    if (!response.ok) {
      throw new Error(`${this.id} failed: ${response.status} ${await response.text()}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: unknown[];
        };
      }>;
      usage?: unknown;
    };

    const message = data.choices?.[0]?.message;
    const usage = normalizeOpenAICompatibleUsage(data.usage);

    return {
      text: message?.content ?? "",
      providerId: this.id,
      ...(message?.tool_calls ? { toolCalls: message.tool_calls } : {}),
      ...(usage ? { usage } : {})
    };
  }
}
