import type {
  ToolCall,
  ToolDefinition,
  ToolProvider,
  ToolResult
} from "../actions/contracts.js";
import type { PersonalMemoryStore } from "./personal.js";

const TOOL_NAME = "personal_memory_search";
const DEFAULT_LIMIT = 5;
const MAX_QUERY_LENGTH = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type PersonalMemoryToolContext = {
  viewerId: string | (() => string);
  subjectId: string;
  limit?: number;
};

export class PersonalMemoryToolProvider implements ToolProvider {
  readonly id = "personal-memory";

  constructor(
    private readonly store: PersonalMemoryStore,
    private readonly context: PersonalMemoryToolContext
  ) {}

  async listTools(): Promise<ToolDefinition[]> {
    return [
      {
        name: TOOL_NAME,
        description:
          "Search the authorized personal reference facts available to the current viewer. " +
          "Use this only when the user asks a factual personal question about the configured subject. " +
          "The viewer and subject are fixed by the server; do not ask for or invent identity IDs.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              minLength: 1,
              maxLength: MAX_QUERY_LENGTH
            }
          },
          required: ["query"],
          additionalProperties: false
        },
        effect: "read"
      }
    ];
  }

  async callTool(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    if (call.name !== TOOL_NAME) {
      return this.failure(call, `Unknown memory tool: ${call.name}`);
    }
    if (signal.aborted) {
      return this.failure(call, "Memory lookup cancelled");
    }
    if (!isRecord(call.arguments)) {
      return this.failure(call, "personal_memory_search requires an object");
    }

    const query = call.arguments.query;
    if (
      typeof query !== "string" ||
      query.trim().length === 0 ||
      query.length > MAX_QUERY_LENGTH
    ) {
      return this.failure(call, `query must be 1..${MAX_QUERY_LENGTH} characters`);
    }

    const viewerId =
      typeof this.context.viewerId === "function"
        ? this.context.viewerId()
        : this.context.viewerId;

    const facts = await this.store.recall({
      viewerId,
      subjectId: this.context.subjectId,
      query,
      limit: this.context.limit ?? DEFAULT_LIMIT
    });

    if (signal.aborted) {
      return this.failure(call, "Memory lookup cancelled");
    }

    return {
      name: call.name,
      ok: true,
      ...(call.callId ? { callId: call.callId } : {}),
      value: facts.map((fact) => ({
        kind: fact.kind,
        text: fact.text,
        sourceType: fact.source.type,
        ...(fact.confidence !== undefined
          ? { confidence: fact.confidence }
          : {}),
        updatedAt: fact.updatedAt
      })),
      scheduling: "silent"
    };
  }

  private failure(call: ToolCall, error: string): ToolResult {
    return {
      name: call.name,
      ok: false,
      ...(call.callId ? { callId: call.callId } : {}),
      error,
      scheduling: "silent"
    };
  }
}
