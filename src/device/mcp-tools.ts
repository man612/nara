import type {
  ToolCall,
  ToolDefinition,
  ToolProvider,
  ToolResult
} from "../actions/contracts.js";
import type { FirmwareSessionTransport } from "../gateway.js";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const REQUEST_TIMEOUT_MS = 15000;
const MAX_TOOL_LIST_PAGES = 8;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  detachAbort?: () => void;
};

type DeviceToolSpec = ToolDefinition & {
  mcpName: string;
  validate(argumentsValue: unknown): Record<string, unknown>;
};

const deviceToolSpecs: DeviceToolSpec[] = [
  {
    name: "device_get_status",
    mcpName: "self.get_device_status",
    description: "Read the device's current speaker, screen, battery, and network status.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    effect: "read",
    validate(argumentsValue) {
      if (
        argumentsValue !== undefined &&
        (!isRecord(argumentsValue) || Object.keys(argumentsValue).length > 0)
      ) {
        throw new Error("device_get_status does not accept arguments");
      }
      return {};
    }
  },
  {
    name: "device_set_volume",
    mcpName: "self.audio_speaker.set_volume",
    description: "Set the device speaker volume from 0 to 100.",
    inputSchema: {
      type: "object",
      properties: {
        volume: {
          type: "integer",
          minimum: 0,
          maximum: 100
        }
      },
      required: ["volume"],
      additionalProperties: false
    },
    effect: "write",
    validate(argumentsValue) {
      if (!isRecord(argumentsValue)) {
        throw new Error("device_set_volume requires an object");
      }
      const volume = argumentsValue.volume;
      if (
        typeof volume !== "number" ||
        !Number.isInteger(volume) ||
        volume < 0 ||
        volume > 100
      ) {
        throw new Error("volume must be an integer from 0 to 100");
      }
      return { volume };
    }
  },
  {
    name: "device_set_reflex",
    mcpName: "self.reflex.configure",
    description:
      "Change a local flip, shake, spin, tap, double-tap, hold, or stroke/pet reaction only when the user explicitly asks to customize it.",
    inputSchema: {
      type: "object",
      properties: {
        gesture: {
          type: "string",
          enum: ["flip", "shake", "spin", "tap", "double_tap", "hold", "stroke", "pet"]
        },
        enabled: { type: "boolean" },
        emotion: {
          type: "string",
          enum: ["neutral", "happy", "shy", "sad", "annoyed", "surprised"]
        },
        sound: {
          type: "string",
          maxLength: 110,
          description:
            "none, builtin:popup, builtin:exclamation, or asset:<local Ogg asset name>"
        },
        preview: { type: "boolean" }
      },
      required: ["gesture"],
      additionalProperties: false
    },
    effect: "write",
    validate(argumentsValue) {
      if (!isRecord(argumentsValue)) {
        throw new Error("device_set_reflex requires an object");
      }
      const gesture = argumentsValue.gesture;
      if (
        typeof gesture !== "string" ||
        !["flip", "shake", "spin", "tap", "double_tap", "hold", "stroke", "pet"].includes(gesture)
      ) {
        throw new Error(
          "gesture must be flip, shake, spin, tap, double_tap, hold, stroke, or pet"
        );
      }

      const result: Record<string, unknown> = { gesture };
      if (argumentsValue.enabled !== undefined) {
        if (typeof argumentsValue.enabled !== "boolean") {
          throw new Error("enabled must be boolean");
        }
        result.enabled = argumentsValue.enabled;
      }
      if (argumentsValue.emotion !== undefined) {
        if (
          typeof argumentsValue.emotion !== "string" ||
          ![
            "neutral",
            "happy",
            "shy",
            "sad",
            "annoyed",
            "surprised"
          ].includes(argumentsValue.emotion)
        ) {
          throw new Error("invalid reflex emotion");
        }
        result.emotion = argumentsValue.emotion;
      }
      if (argumentsValue.sound !== undefined) {
        if (
          typeof argumentsValue.sound !== "string" ||
          argumentsValue.sound.length === 0 ||
          argumentsValue.sound.length > 110
        ) {
          throw new Error("sound must be a non-empty string up to 110 characters");
        }
        result.sound = argumentsValue.sound;
      }
      if (argumentsValue.preview !== undefined) {
        if (typeof argumentsValue.preview !== "boolean") {
          throw new Error("preview must be boolean");
        }
        result.preview = argumentsValue.preview;
      }
      return result;
    }
  },
  {
    name: "device_companion",
    mcpName: "self.companion.control",
    description:
      "Use compact local companion features: show a device notification, run a lightweight network diagnostic, or start/stop/read the offline Nara Says minigame.",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: [
            "notify",
            "network_test",
            "game_start",
            "game_stop",
            "game_status"
          ]
        },
        text: {
          type: "string",
          minLength: 1,
          maxLength: 220
        },
        emotion: {
          type: "string",
          enum: ["neutral", "happy", "shy", "sad", "annoyed", "surprised"]
        },
        sound: {
          type: "string",
          maxLength: 110
        },
        rounds: {
          type: "integer",
          minimum: 1,
          maximum: 12
        }
      },
      required: ["op"],
      additionalProperties: false
    },
    effect: "write",
    validate(argumentsValue) {
      if (!isRecord(argumentsValue)) {
        throw new Error("device_companion requires an object");
      }
      const op = argumentsValue.op;
      const operations = [
        "notify",
        "network_test",
        "game_start",
        "game_stop",
        "game_status"
      ] as const;
      if (
        typeof op !== "string" ||
        !operations.includes(op as (typeof operations)[number])
      ) {
        throw new Error("invalid device companion operation");
      }

      const result: Record<string, unknown> = { op };
      if (op === "notify") {
        if (
          typeof argumentsValue.text !== "string" ||
          argumentsValue.text.trim().length === 0 ||
          argumentsValue.text.length > 220
        ) {
          throw new Error("text is required for notify and must be at most 220 characters");
        }
        result.text = argumentsValue.text.trim();
        if (argumentsValue.emotion !== undefined) {
          if (
            typeof argumentsValue.emotion !== "string" ||
            !["neutral", "happy", "shy", "sad", "annoyed", "surprised"].includes(
              argumentsValue.emotion
            )
          ) {
            throw new Error("invalid notification emotion");
          }
          result.emotion = argumentsValue.emotion;
        }
        if (argumentsValue.sound !== undefined) {
          if (
            typeof argumentsValue.sound !== "string" ||
            argumentsValue.sound.length > 110
          ) {
            throw new Error("notification sound must be at most 110 characters");
          }
          result.sound = argumentsValue.sound;
        }
      } else if (op === "game_start") {
        const rounds = argumentsValue.rounds ?? 5;
        if (
          typeof rounds !== "number" ||
          !Number.isInteger(rounds) ||
          rounds < 1 ||
          rounds > 12
        ) {
          throw new Error("rounds must be an integer from 1 to 12");
        }
        result.rounds = rounds;
      }
      return result;
    }
  },
  {
    name: "device_offline_utility",
    mcpName: "self.offline.utility",
    description:
      "Configure RTC-backed local utilities that continue working without Internet: timer, daily alarm, timezone, status, or show time.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "timer",
            "cancel_timer",
            "alarm",
            "cancel_alarm",
            "timezone",
            "status",
            "show_time"
          ]
        },
        seconds: {
          type: "integer",
          minimum: 1,
          maximum: 86400
        },
        hour: {
          type: "integer",
          minimum: 0,
          maximum: 23
        },
        minute: {
          type: "integer",
          minimum: 0,
          maximum: 59
        },
        timezone_offset_minutes: {
          type: "integer",
          minimum: -720,
          maximum: 840
        }
      },
      required: ["action"],
      additionalProperties: false
    },
    effect: "write",
    validate(argumentsValue) {
      if (!isRecord(argumentsValue)) {
        throw new Error("device_offline_utility requires an object");
      }

      const action = argumentsValue.action;
      const actions = [
        "timer",
        "cancel_timer",
        "alarm",
        "cancel_alarm",
        "timezone",
        "status",
        "show_time"
      ] as const;
      if (
        typeof action !== "string" ||
        !actions.includes(action as (typeof actions)[number])
      ) {
        throw new Error("invalid offline utility action");
      }

      const result: Record<string, unknown> = { action };
      const integerInRange = (
        name: string,
        value: unknown,
        min: number,
        max: number
      ): number => {
        if (
          typeof value !== "number" ||
          !Number.isInteger(value) ||
          value < min ||
          value > max
        ) {
          throw new Error(`${name} must be an integer from ${min} to ${max}`);
        }
        return value;
      };

      if (action === "timer") {
        result.seconds = integerInRange(
          "seconds",
          argumentsValue.seconds,
          1,
          86400
        );
      } else if (action === "alarm") {
        result.hour = integerInRange("hour", argumentsValue.hour, 0, 23);
        result.minute = integerInRange(
          "minute",
          argumentsValue.minute,
          0,
          59
        );
      } else if (action === "timezone") {
        result.timezone_offset_minutes = integerInRange(
          "timezone_offset_minutes",
          argumentsValue.timezone_offset_minutes,
          -720,
          840
        );
      }

      return result;
    }
  }
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseTextValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function compactMcpResult(result: unknown): unknown {
  if (!isRecord(result)) return result;

  const content = result.content;
  if (Array.isArray(content)) {
    const textItems = content
      .filter(isRecord)
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text as string);

    if (textItems.length === 1) {
      return parseTextValue(textItems[0]!);
    }
    if (textItems.length > 1) {
      return textItems.map(parseTextValue);
    }
  }

  return result;
}

function waitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error("Tool call cancelled"));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new Error("Tool call cancelled"));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

export class DeviceMcpToolProvider implements ToolProvider {
  readonly id = "device-mcp";

  private readonly pending = new Map<number, PendingRequest>();
  private readonly specs = new Map(
    deviceToolSpecs.map((spec) => [spec.name, spec])
  );
  private nextRequestId = 1;
  private discovery: Promise<Set<string>> | null = null;
  private closed = false;

  constructor(private readonly transport: FirmwareSessionTransport) {}

  async listTools(): Promise<ToolDefinition[]> {
    return deviceToolSpecs.map(
      ({ mcpName: _mcpName, validate: _validate, ...definition }) => definition
    );
  }

  async callTool(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    const spec = this.specs.get(call.name);
    if (!spec) {
      return this.failure(call, `Unknown device tool: ${call.name}`);
    }

    let args: Record<string, unknown>;
    try {
      args = spec.validate(call.arguments);
    } catch (error) {
      return this.failure(
        call,
        error instanceof Error ? error.message : "Invalid tool arguments"
      );
    }

    const available = await waitWithAbort(this.discoverTools(), signal);
    if (!available.has(spec.mcpName)) {
      return this.failure(
        call,
        `Device does not expose MCP tool: ${spec.mcpName}`
      );
    }

    try {
      const result = await this.request(
        "tools/call",
        {
          name: spec.mcpName,
          arguments: args
        },
        signal
      );

      if (isRecord(result) && result.isError === true) {
        return this.failure(
          call,
          `Device tool failed: ${JSON.stringify(compactMcpResult(result))}`
        );
      }

      return {
        name: call.name,
        ok: true,
        ...(call.callId ? { callId: call.callId } : {}),
        value: compactMcpResult(result)
      };
    } catch (error) {
      return this.failure(
        call,
        error instanceof Error ? error.message : "Device MCP call failed"
      );
    }
  }

  onEvent(event: unknown): boolean {
    if (!isRecord(event) || event.type !== "mcp" || !isRecord(event.payload)) {
      return false;
    }

    const payload = event.payload;
    if (payload.jsonrpc !== "2.0" || typeof payload.id !== "number") {
      return true;
    }

    const pending = this.pending.get(payload.id);
    if (!pending) return true;

    this.pending.delete(payload.id);
    clearTimeout(pending.timer);
    pending.detachAbort?.();

    if (isRecord(payload.error)) {
      const message =
        typeof payload.error.message === "string"
          ? payload.error.message
          : "Device MCP request failed";
      pending.reject(new Error(message));
      return true;
    }

    pending.resolve(payload.result);
    return true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.detachAbort?.();
      pending.reject(new Error(`Device MCP session closed while request ${id} was pending`));
    }
    this.pending.clear();
  }

  private failure(call: ToolCall, error: string): ToolResult {
    return {
      name: call.name,
      ok: false,
      ...(call.callId ? { callId: call.callId } : {}),
      error
    };
  }

  private discoverTools(): Promise<Set<string>> {
    if (this.discovery) return this.discovery;

    this.discovery = (async () => {
      await this.request("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: "nara-gateway",
          version: "0.1.0"
        }
      });

      this.transport.sendJson({
        type: "mcp",
        payload: {
          jsonrpc: "2.0",
          method: "notifications/initialized"
        }
      });

      const tools = new Set<string>();
      let cursor: string | undefined;

      for (let page = 0; page < MAX_TOOL_LIST_PAGES; page += 1) {
        const result = await this.request(
          "tools/list",
          cursor ? { cursor } : {}
        );

        if (!isRecord(result) || !Array.isArray(result.tools)) {
          throw new Error("Device MCP tools/list returned an invalid result");
        }

        for (const tool of result.tools) {
          if (isRecord(tool) && typeof tool.name === "string") {
            tools.add(tool.name);
          }
        }

        if (typeof result.nextCursor !== "string" || result.nextCursor === "") {
          return tools;
        }
        cursor = result.nextCursor;
      }

      throw new Error("Device MCP tools/list exceeded the page limit");
    })().catch((error) => {
      this.discovery = null;
      throw error;
    });

    return this.discovery;
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error("Device MCP provider is closed"));
    }
    if (signal?.aborted) {
      return Promise.reject(new Error("Tool call cancelled"));
    }

    const id = this.nextRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.detachAbort?.();
        reject(new Error(`Device MCP request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);

      const pending: PendingRequest = {
        resolve,
        reject,
        timer
      };

      if (signal) {
        const onAbort = () => {
          const active = this.pending.get(id);
          if (!active) return;
          this.pending.delete(id);
          clearTimeout(active.timer);
          reject(new Error("Tool call cancelled"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        pending.detachAbort = () => signal.removeEventListener("abort", onAbort);
      }

      this.pending.set(id, pending);

      try {
        this.transport.sendJson({
          type: "mcp",
          payload: {
            jsonrpc: "2.0",
            id,
            method,
            params
          }
        });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        pending.detachAbort?.();
        reject(
          error instanceof Error
            ? error
            : new Error("Failed to send Device MCP request")
        );
      }
    });
  }
}
