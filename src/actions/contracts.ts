export type ToolEffect = "read" | "write" | "sensitive";
export type ToolBehavior = "blocking" | "non_blocking";
export type ToolResultScheduling = "interrupt" | "when_idle" | "silent";

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  effect: ToolEffect;
  behavior?: ToolBehavior;
};

export type ToolCall = {
  name: string;
  arguments: unknown;
  callId?: string;
};

export type ToolResult = {
  name: string;
  ok: boolean;
  callId?: string;
  value?: unknown;
  error?: string;
  scheduling?: ToolResultScheduling;
};

export interface ToolProvider {
  readonly id: string;
  listTools(): Promise<ToolDefinition[]>;
  callTool(call: ToolCall, signal: AbortSignal): Promise<ToolResult>;
  onEvent?(event: unknown): boolean | Promise<boolean>;
  close?(): void | Promise<void>;
}
