import type {
  BrainMessage,
  BrainProvider,
  BrainRequest,
  BrainResponse,
  BrainToolCall,
  ProviderUsage
} from "../../contracts/providers.js";

export type OpenAICompatibleConfig = {
  id: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

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

function serializeBrainMessage(message: BrainMessage): Record<string, unknown> {
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content || null,
      ...(message.toolCalls && message.toolCalls.length > 0
        ? {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments:
                  typeof call.arguments === "string"
                    ? call.arguments
                    : JSON.stringify(call.arguments ?? {})
              }
            }))
          }
        : {})
    };
  }

  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content,
      tool_call_id: message.toolCallId,
      name: message.name
    };
  }

  return {
    role: message.role,
    content: message.content
  };
}

function normalizeToolCalls(value: unknown): BrainToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const calls: BrainToolCall[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as Record<string, unknown>;
    const fn = record.function;
    if (!fn || typeof fn !== "object") continue;
    const functionRecord = fn as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      typeof functionRecord.name !== "string"
    ) {
      continue;
    }

    let args: unknown = {};
    if (typeof functionRecord.arguments === "string") {
      try {
        args = JSON.parse(functionRecord.arguments);
      } catch {
        args = functionRecord.arguments;
      }
    } else if (functionRecord.arguments !== undefined) {
      args = functionRecord.arguments;
    }

    calls.push({
      id: record.id,
      name: functionRecord.name,
      arguments: args
    });
  }

  return calls.length > 0 ? calls : undefined;
}

export class OpenAICompatibleBrain implements BrainProvider {
  readonly id: string;

  constructor(private readonly config: OpenAICompatibleConfig) {
    this.id = config.id;
  }

  async complete(request: BrainRequest): Promise<BrainResponse> {
    const baseUrl = this.config.baseUrl.replace(/\/$/, "");
    const timeoutSignal = AbortSignal.timeout(
      this.config.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    );
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeoutSignal])
      : timeoutSignal;

    const response = await (this.config.fetchImpl ?? fetch)(
      `${baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.config.apiKey
            ? { authorization: `Bearer ${this.config.apiKey}` }
            : {})
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: request.messages.map(serializeBrainMessage),
          ...(request.tools ? { tools: request.tools } : {})
        }),
        signal
      }
    );

    if (!response.ok) {
      throw new Error(`${this.id} failed: ${response.status} ${await response.text()}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: unknown;
        };
      }>;
      usage?: unknown;
    };

    const message = data.choices?.[0]?.message;
    const usage = normalizeOpenAICompatibleUsage(data.usage);
    const toolCalls = normalizeToolCalls(message?.tool_calls);

    return {
      text: message?.content ?? "",
      providerId: this.id,
      ...(toolCalls ? { toolCalls } : {}),
      ...(usage ? { usage } : {})
    };
  }
}
