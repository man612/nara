import type {
  ToolCall,
  ToolDefinition,
  ToolProvider,
  ToolResult
} from "../actions/contracts.js";
import type { BriefingService } from "../briefing/service.js";
import type { OpenMeteoWeatherClient } from "../briefing/weather.js";
import { describeWeatherId } from "../briefing/weather.js";
import type { ProviderBudgetMonitor } from "../budget/monitor.js";
import type { HermesAgentClient } from "../agents/hermes.js";
import type { VoiceLatencyMonitor } from "../telemetry/voice-latency.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class CompanionStatusToolProvider implements ToolProvider {
  readonly id = "companion:status";

  constructor(
    private readonly options: {
      briefing: BriefingService;
      weather?: OpenMeteoWeatherClient;
      budgets?: ProviderBudgetMonitor;
      latency: VoiceLatencyMonitor;
      hermes?: HermesAgentClient;
      deviceId?: string;
    }
  ) {}

  async listTools(): Promise<ToolDefinition[]> {
    return [
      {
        name: "companion_check",
        description:
          "Read current companion service status. Use weather for current/today weather, " +
          "ai_budget for provider balances/limits, latency for measured voice response delay, " +
          "hermes for delegated-agent availability, or briefing for a compact deterministic summary.",
        inputSchema: {
          type: "object",
          properties: {
            op: {
              type: "string",
              enum: [
                "weather",
                "ai_budget",
                "latency",
                "hermes",
                "briefing"
              ]
            }
          },
          required: ["op"],
          additionalProperties: false
        },
        effect: "read"
      }
    ];
  }

  async callTool(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    try {
      if (call.name !== "companion_check" || !isRecord(call.arguments)) {
        return this.failure(call, "Invalid companion_check call");
      }
      const op = call.arguments.op;
      if (typeof op !== "string") {
        return this.failure(call, "op is required");
      }

      switch (op) {
        case "weather": {
          if (!this.options.weather) {
            return this.failure(call, "Weather is not configured");
          }
          const snapshot = await this.options.weather.current(signal);
          return this.success(call, {
            summary: describeWeatherId(snapshot),
            snapshot
          });
        }
        case "ai_budget": {
          if (!this.options.budgets) {
            return this.failure(call, "AI budget monitoring is not configured");
          }
          return this.success(
            call,
            await this.options.budgets.readAll(signal)
          );
        }
        case "latency":
          return this.success(call, {
            latest: this.options.latency.latest(this.options.deviceId),
            summary: this.options.latency.summary(this.options.deviceId)
          });
        case "hermes": {
          if (!this.options.hermes) {
            return this.failure(call, "Hermes is not configured");
          }
          return this.success(call, {
            available: await this.options.hermes.health(signal)
          });
        }
        case "briefing": {
          const snapshot = await this.options.briefing.snapshot(signal);
          return this.success(call, {
            summary: this.options.briefing.describeId(snapshot),
            snapshot
          });
        }
        default:
          return this.failure(call, "Unsupported companion check");
      }
    } catch (error) {
      return this.failure(
        call,
        error instanceof Error ? error.message : "Companion check failed"
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
