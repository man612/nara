import { describe, expect, it } from "vitest";
import type {
  ToolCall,
  ToolDefinition,
  ToolProvider,
  ToolResult
} from "../src/actions/contracts.js";
import { ActionRuntime } from "../src/actions/runtime.js";

class FakeToolProvider implements ToolProvider {
  readonly calls: ToolCall[] = [];

  constructor(
    readonly id: string,
    private readonly definitions: ToolDefinition[],
    private readonly impl: (
      call: ToolCall,
      signal: AbortSignal
    ) => Promise<ToolResult>
  ) {}

  async listTools(): Promise<ToolDefinition[]> {
    return this.definitions;
  }

  async callTool(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    this.calls.push(call);
    return this.impl(call, signal);
  }
}

const definition: ToolDefinition = {
  name: "device_set_volume",
  description: "Set volume.",
  inputSchema: {
    type: "object",
    properties: {
      volume: { type: "integer" }
    },
    required: ["volume"]
  },
  effect: "write"
};

describe("ActionRuntime", () => {
  it("routes a tool call to the provider that declared it", async () => {
    const provider = new FakeToolProvider(
      "device",
      [definition],
      async (call) => ({
        name: call.name,
        ...(call.callId ? { callId: call.callId } : {}),
        ok: true,
        value: true
      })
    );
    const runtime = await ActionRuntime.create([provider]);

    await expect(
      runtime.execute({
        name: "device_set_volume",
        arguments: { volume: 30 },
        callId: "call-1"
      })
    ).resolves.toEqual({
      name: "device_set_volume",
      callId: "call-1",
      ok: true,
      value: true
    });

    expect(provider.calls).toEqual([
      {
        name: "device_set_volume",
        arguments: { volume: 30 },
        callId: "call-1"
      }
    ]);
  });

  it("cancels active work independently from the voice lifecycle", async () => {
    let observedAbort = false;
    const provider = new FakeToolProvider(
      "device",
      [definition],
      (call, signal) =>
        new Promise<ToolResult>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              resolve({
                name: call.name,
                ...(call.callId ? { callId: call.callId } : {}),
                ok: false,
                error: "cancelled"
              });
            },
            { once: true }
          );
        })
    );
    const runtime = await ActionRuntime.create([provider]);
    const pending = runtime.execute({
      name: "device_set_volume",
      arguments: { volume: 30 },
      callId: "call-cancel"
    });

    runtime.cancel(["call-cancel"]);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: "cancelled"
    });
    expect(observedAbort).toBe(true);
  });

  it("rejects duplicate tool names and oversized catalogs", async () => {
    const providerA = new FakeToolProvider("a", [definition], async () => ({
      name: definition.name,
      ok: true
    }));
    const providerB = new FakeToolProvider("b", [definition], async () => ({
      name: definition.name,
      ok: true
    }));

    await expect(ActionRuntime.create([providerA, providerB])).rejects.toThrow(
      /Duplicate tool name/
    );

    await expect(
      ActionRuntime.create([providerA], { maxExposedTools: 0 })
    ).rejects.toThrow(/above the configured limit/);
  });
});
