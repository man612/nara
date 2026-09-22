import type {
  ActionAuthorizer,
  ActionAuthorizationDecision,
  ToolCall,
  ToolDefinition,
  ToolProvider,
  ToolResult
} from "./contracts.js";

type ToolRoute = {
  provider: ToolProvider;
  definition: ToolDefinition;
};

export type ActionRuntimeOptions = {
  maxExposedTools?: number;
  authorize?: ActionAuthorizer;
};

function defaultAuthorize(
  definition: ToolDefinition
): ActionAuthorizationDecision {
  if (definition.effect === "sensitive") {
    return {
      allowed: false,
      reason: "Sensitive action requires explicit authorization"
    };
  }
  return { allowed: true };
}

export class ActionRuntime {
  private readonly routes = new Map<string, ToolRoute>();
  private readonly active = new Map<string, AbortController>();
  private closed = false;

  private constructor(
    private readonly providers: ToolProvider[],
    private readonly maxExposedTools: number,
    private readonly authorize: ActionAuthorizer,
    private readonly hasExplicitAuthorizer: boolean
  ) {}

  static async create(
    providers: ToolProvider[],
    options: ActionRuntimeOptions = {}
  ): Promise<ActionRuntime> {
    const runtime = new ActionRuntime(
      providers,
      options.maxExposedTools ?? 20,
      options.authorize ??
        ((request) => defaultAuthorize(request.definition)),
      options.authorize !== undefined
    );
    await runtime.loadRoutes();
    return runtime;
  }

  listTools(): ToolDefinition[] {
    return [...this.routes.values()]
      .map(({ definition }) => definition)
      .filter(
        (definition) =>
          definition.effect !== "sensitive" ||
          this.hasExplicitAuthorizer
      );
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    if (this.closed) {
      return {
        name: call.name,
        ok: false,
        ...(call.callId ? { callId: call.callId } : {}),
        error: "Action runtime is closed"
      };
    }

    const route = this.routes.get(call.name);
    if (!route) {
      return {
        name: call.name,
        ok: false,
        ...(call.callId ? { callId: call.callId } : {}),
        error: `Unknown tool: ${call.name}`
      };
    }

    let authorization: ActionAuthorizationDecision;
    try {
      authorization = await this.authorize({
        call,
        definition: route.definition,
        providerId: route.provider.id
      });
    } catch {
      return {
        name: call.name,
        ok: false,
        ...(call.callId ? { callId: call.callId } : {}),
        error: "Action authorization failed"
      };
    }

    if (!authorization.allowed) {
      return {
        name: call.name,
        ok: false,
        ...(call.callId ? { callId: call.callId } : {}),
        error: authorization.reason
      };
    }

    const controller = new AbortController();
    if (call.callId) {
      this.active.get(call.callId)?.abort();
      this.active.set(call.callId, controller);
    }

    try {
      return await route.provider.callTool(call, controller.signal);
    } catch (error) {
      return {
        name: call.name,
        ok: false,
        ...(call.callId ? { callId: call.callId } : {}),
        error:
          error instanceof Error
            ? error.message
            : "Tool execution failed"
      };
    } finally {
      if (call.callId && this.active.get(call.callId) === controller) {
        this.active.delete(call.callId);
      }
    }
  }

  cancel(callIds: string[]): void {
    for (const callId of callIds) {
      this.active.get(callId)?.abort();
      this.active.delete(callId);
    }
  }

  async onEvent(event: unknown): Promise<boolean> {
    for (const provider of this.providers) {
      if (await provider.onEvent?.(event)) return true;
    }
    return false;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    for (const controller of this.active.values()) {
      controller.abort();
    }
    this.active.clear();

    await Promise.allSettled(
      this.providers.map(async (provider) => {
        await provider.close?.();
      })
    );
  }

  private async loadRoutes(): Promise<void> {
    for (const provider of this.providers) {
      for (const definition of await provider.listTools()) {
        if (this.routes.has(definition.name)) {
          throw new Error(`Duplicate tool name: ${definition.name}`);
        }
        this.routes.set(definition.name, { provider, definition });
      }
    }

    const exposedCount = this.listTools().length;
    if (exposedCount > this.maxExposedTools) {
      throw new Error(
        `Action runtime exposes ${exposedCount} tools, above the configured limit of ${this.maxExposedTools}`
      );
    }
  }
}
