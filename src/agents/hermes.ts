import type {
  ToolCall,
  ToolDefinition,
  ToolProvider,
  ToolResult
} from "../actions/contracts.js";

export type HermesRun = {
  runId: string;
  status: string;
  sessionId?: string;
  output?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
};

export type HermesAgentClientOptions = {
  baseUrl: string;
  apiKey: string;
  profile?: string;
  fetchImpl?: typeof fetch;
};

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Hermes returned an invalid object");
  }
  return value as Record<string, unknown>;
}

function numberField(
  object: Record<string, unknown>,
  key: string
): number | undefined {
  const value = object[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export class HermesAgentClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: HermesAgentClientOptions) {
    if (!options.apiKey.trim()) {
      throw new Error("Hermes API key is required");
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
  }

  async health(signal?: AbortSignal): Promise<boolean> {
    const response = await this.fetchImpl(this.endpoint("/health"), {
      headers: this.headers(false),
      signal
    });
    return response.ok;
  }

  async startRun(
    input: {
      task: string;
      sessionId?: string;
      instructions?: string;
      model?: string;
      provider?: string;
      idempotencyKey?: string;
    },
    signal?: AbortSignal
  ): Promise<HermesRun> {
    const response = await this.fetchImpl(this.endpoint("/v1/runs"), {
      method: "POST",
      headers: {
        ...this.headers(true),
        ...(input.idempotencyKey
          ? { "idempotency-key": input.idempotencyKey }
          : {})
      },
      body: JSON.stringify({
        input: input.task,
        ...(input.sessionId ? { session_id: input.sessionId } : {}),
        ...(input.instructions ? { instructions: input.instructions } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.provider ? { provider: input.provider } : {})
      }),
      signal
    });

    if (!response.ok) {
      throw new Error(
        "Hermes run creation failed: HTTP " + response.status
      );
    }
    return this.parseRun(await response.json());
  }

  async getRun(runId: string, signal?: AbortSignal): Promise<HermesRun> {
    const response = await this.fetchImpl(
      this.endpoint("/v1/runs/" + encodeURIComponent(runId)),
      { headers: this.headers(false), signal }
    );
    if (!response.ok) {
      throw new Error(
        "Hermes run status failed: HTTP " + response.status
      );
    }
    return this.parseRun(await response.json());
  }

  async stopRun(runId: string, signal?: AbortSignal): Promise<HermesRun> {
    const response = await this.fetchImpl(
      this.endpoint("/v1/runs/" + encodeURIComponent(runId) + "/stop"),
      {
        method: "POST",
        headers: this.headers(true),
        body: "{}",
        signal
      }
    );
    if (!response.ok) {
      throw new Error("Hermes run stop failed: HTTP " + response.status);
    }
    return this.parseRun(await response.json(), runId);
  }

  private endpoint(path: string): string {
    const prefix = this.options.profile
      ? "/p/" + encodeURIComponent(this.options.profile)
      : "";
    return this.baseUrl + prefix + path;
  }

  private headers(json: boolean): Record<string, string> {
    return {
      authorization: "Bearer " + this.options.apiKey,
      ...(json ? { "content-type": "application/json" } : {})
    };
  }

  private parseRun(value: unknown, fallbackRunId?: string): HermesRun {
    const root = asObject(value);
    const runId =
      typeof root.run_id === "string"
        ? root.run_id
        : fallbackRunId;
    const status =
      typeof root.status === "string" ? root.status : "unknown";
    if (!runId) {
      throw new Error("Hermes response has no run_id");
    }

    const usage =
      root.usage && typeof root.usage === "object"
        ? asObject(root.usage)
        : undefined;
    const inputTokens = usage
      ? numberField(usage, "input_tokens")
      : undefined;
    const outputTokens = usage
      ? numberField(usage, "output_tokens")
      : undefined;
    const totalTokens = usage
      ? numberField(usage, "total_tokens")
      : undefined;

    return {
      runId,
      status,
      ...(typeof root.session_id === "string"
        ? { sessionId: root.session_id }
        : {}),
      ...(typeof root.output === "string"
        ? { output: root.output }
        : {}),
      ...(usage
        ? {
            usage: {
              ...(inputTokens !== undefined ? { inputTokens } : {}),
              ...(outputTokens !== undefined ? { outputTokens } : {}),
              ...(totalTokens !== undefined ? { totalTokens } : {})
            }
          }
        : {})
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class HermesAgentToolProvider implements ToolProvider {
  readonly id = "agent:hermes";

  constructor(
    private readonly client: HermesAgentClient,
    private readonly defaults: {
      instructions?: string;
      model?: string;
      provider?: string;
    } = {}
  ) {}

  async listTools(): Promise<ToolDefinition[]> {
    return [
      {
        name: "agent_delegate",
        description:
          "Delegate long, multi-step web, research, browser, or automation work to Hermes. " +
          "Use start only for genuinely long tasks; use status or stop with a returned run_id. " +
          "Do not use this for simple device, weather, media, timer, or status actions.",
        inputSchema: {
          type: "object",
          properties: {
            op: {
              type: "string",
              enum: ["start", "status", "stop"]
            },
            task: {
              type: "string",
              minLength: 1,
              maxLength: 4000
            },
            run_id: {
              type: "string",
              minLength: 1,
              maxLength: 128
            }
          },
          required: ["op"],
          additionalProperties: false
        },
        effect: "write",
        behavior: "non_blocking"
      }
    ];
  }

  async callTool(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    try {
      if (call.name !== "agent_delegate" || !isRecord(call.arguments)) {
        return this.failure(call, "Invalid agent_delegate call");
      }

      const op = call.arguments.op;
      if (typeof op !== "string") {
        return this.failure(call, "op is required");
      }

      if (op === "start") {
        const task = call.arguments.task;
        if (
          typeof task !== "string" ||
          task.trim().length === 0 ||
          task.length > 4000
        ) {
          return this.failure(call, "task is required for start");
        }

        const run = await this.client.startRun(
          {
            task: task.trim(),
            ...(this.defaults.instructions
              ? { instructions: this.defaults.instructions }
              : {}),
            ...(this.defaults.model
              ? { model: this.defaults.model }
              : {}),
            ...(this.defaults.provider
              ? { provider: this.defaults.provider }
              : {}),
            ...(call.callId
              ? { idempotencyKey: "nara-" + call.callId }
              : {})
          },
          signal
        );
        return this.success(call, run);
      }

      const runId = call.arguments.run_id;
      if (typeof runId !== "string" || !runId.trim()) {
        return this.failure(call, "run_id is required");
      }
      if (op === "status") {
        return this.success(
          call,
          await this.client.getRun(runId.trim(), signal)
        );
      }
      if (op === "stop") {
        return this.success(
          call,
          await this.client.stopRun(runId.trim(), signal)
        );
      }
      return this.failure(call, "op must be start, status, or stop");
    } catch (error) {
      return this.failure(
        call,
        error instanceof Error
          ? error.message
          : "Hermes operation failed"
      );
    }
  }

  private success(call: ToolCall, value: unknown): ToolResult {
    return {
      name: call.name,
      ok: true,
      ...(call.callId ? { callId: call.callId } : {}),
      value,
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
