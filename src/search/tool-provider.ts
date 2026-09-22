import type {
  ToolCall,
  ToolDefinition,
  ToolProvider,
  ToolResult,
} from "../actions/contracts.js";
import type { SearchProvider } from "../contracts/providers.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class SearchToolProvider implements ToolProvider {
  readonly id = "search:web";

  constructor(private readonly searchProvider: SearchProvider) {}

  async listTools(): Promise<ToolDefinition[]> {
    return [
      {
        name: "web_search",
        description:
          "Search the web for up-to-date factual information. Use only when current external information is needed; prefer local/device tools for local state.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              minLength: 1,
              maxLength: 500,
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 10,
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
        effect: "read",
        behavior: "blocking",
      },
    ];
  }

  async callTool(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    if (call.name !== "web_search" || !isRecord(call.arguments)) {
      return this.failure(call, "Invalid web_search call");
    }

    const query =
      typeof call.arguments.query === "string"
        ? call.arguments.query.trim()
        : "";
    const rawLimit = call.arguments.limit;
    if (!query || query.length > 500) {
      return this.failure(call, "query must contain 1 to 500 characters");
    }
    if (
      rawLimit !== undefined &&
      (!Number.isInteger(rawLimit) ||
        (rawLimit as number) < 1 ||
        (rawLimit as number) > 10)
    ) {
      return this.failure(call, "limit must be an integer from 1 to 10");
    }

    try {
      const results = await this.searchProvider.search(query, {
        ...(typeof rawLimit === "number" ? { limit: rawLimit } : {}),
        signal,
      });
      if (signal.aborted) {
        return this.failure(call, "Search cancelled");
      }
      return {
        name: call.name,
        ok: true,
        ...(call.callId ? { callId: call.callId } : {}),
        value: {
          query,
          providerId: this.searchProvider.id,
          results,
        },
        scheduling: "when_idle",
      };
    } catch (error) {
      if (signal.aborted) {
        return this.failure(call, "Search cancelled");
      }
      return this.failure(
        call,
        error instanceof Error ? error.message : "Search failed",
      );
    }
  }

  private failure(call: ToolCall, error: string): ToolResult {
    return {
      name: call.name,
      ok: false,
      ...(call.callId ? { callId: call.callId } : {}),
      error,
      scheduling: "when_idle",
    };
  }
}
