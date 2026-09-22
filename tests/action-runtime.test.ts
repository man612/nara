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

  it("fails closed for sensitive tools without an explicit authorizer", async () => {
    const sensitive: ToolDefinition = {
      ...definition,
      name: "external_delete",
      effect: "sensitive"
    };
    const provider = new FakeToolProvider(
      "external",
      [sensitive],
      async (call) => ({
        name: call.name,
        ok: true,
        value: "should-not-run"
      })
    );
    const runtime = await ActionRuntime.create([provider]);
    expect(runtime.listTools()).toEqual([]);

    await expect(
      runtime.execute({
        name: "external_delete",
        arguments: { id: "item-1" },
        callId: "sensitive-1"
      })
    ).resolves.toEqual({
      name: "external_delete",
      callId: "sensitive-1",
      ok: false,
      error: "Sensitive action requires explicit authorization"
    });
    expect(provider.calls).toHaveLength(0);
  });

  it("allows an injected authorizer to approve a sensitive call", async () => {
    const sensitive: ToolDefinition = {
      ...definition,
      name: "external_delete",
      effect: "sensitive"
    };
    const provider = new FakeToolProvider(
      "external",
      [sensitive],
      async (call) => ({
        name: call.name,
        ...(call.callId ? { callId: call.callId } : {}),
        ok: true,
        value: "approved"
      })
    );
    const seen: unknown[] = [];
    const runtime = await ActionRuntime.create([provider], {
      authorize: (request) => {
        seen.push(request);
        return { allowed: true };
      }
    });
    expect(runtime.listTools()).toEqual([sensitive]);

    const call: ToolCall = {
      name: "external_delete",
      arguments: { id: "item-1" },
      callId: "sensitive-2"
    };

    await expect(runtime.execute(call)).resolves.toEqual({
      name: "external_delete",
      callId: "sensitive-2",
      ok: true,
      value: "approved"
    });
    expect(seen).toEqual([
      {
        call,
        definition: sensitive,
        providerId: "external"
      }
    ]);
  });

  it("fails closed when the action authorizer itself errors", async () => {
    const provider = new FakeToolProvider(
      "device",
      [definition],
      async (call) => ({
        name: call.name,
        ok: true
      })
    );
    const runtime = await ActionRuntime.create([provider], {
      authorize: () => {
        throw new Error("policy backend unavailable");
      }
    });

    await expect(
      runtime.execute({
        name: "device_set_volume",
        arguments: { volume: 30 },
        callId: "policy-error"
      })
    ).resolves.toEqual({
      name: "device_set_volume",
      callId: "policy-error",
      ok: false,
      error: "Action authorization failed"
    });
    expect(provider.calls).toHaveLength(0);
  });

  it("cancels safely while an asynchronous authorizer is still pending", async () => {
    let resolveAuthorization!: () => void;
    const authorizationStarted = new Promise<void>((resolve) => {
      resolveAuthorization = resolve;
    });
    let releaseAuthorization!: () => void;
    const authorizationGate = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });

    const provider = new FakeToolProvider(
      "device",
      [definition],
      async (call) => ({
        name: call.name,
        ok: true
      })
    );
    const runtime = await ActionRuntime.create([provider], {
      authorize: async () => {
        resolveAuthorization();
        await authorizationGate;
        return { allowed: true };
      }
    });

    const pending = runtime.execute({
      name: "device_set_volume",
      arguments: { volume: 30 },
      callId: "policy-pending"
    });
    await authorizationStarted;
    runtime.cancel(["policy-pending"]);
    releaseAuthorization();

    await expect(pending).resolves.toEqual({
      name: "device_set_volume",
      callId: "policy-pending",
      ok: false,
      error: "Action cancelled"
    });
    expect(provider.calls).toHaveLength(0);
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
