import { describe, expect, it } from "vitest";
import {
  HermesAgentClient,
  HermesAgentToolProvider
} from "../src/agents/hermes.js";

describe("HermesAgentClient", () => {
  it("creates and polls Runs API jobs with bearer auth", async () => {
    const requests: Array<{
      url: string;
      method: string;
      authorization?: string;
      body?: string;
    }> = [];

    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = String(input);
      const authorization =
        new Headers(init?.headers).get("authorization") ?? undefined;
      const body =
        typeof init?.body === "string" ? init.body : undefined;
      requests.push({
        url,
        method: init?.method ?? "GET",
        ...(authorization ? { authorization } : {}),
        ...(body ? { body } : {})
      });

      if (url.endsWith("/v1/runs")) {
        return new Response(
          JSON.stringify({ run_id: "run_1", status: "started" }),
          { status: 202, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith("/v1/runs/run_1")) {
        return new Response(
          JSON.stringify({
            run_id: "run_1",
            status: "completed",
            output: "done",
            usage: {
              input_tokens: 12,
              output_tokens: 34,
              total_tokens: 46
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;

    const client = new HermesAgentClient({
      baseUrl: "https://hermes.example/",
      apiKey: "secret",
      fetchImpl
    });

    await expect(
      client.startRun({ task: "research this" })
    ).resolves.toEqual({
      runId: "run_1",
      status: "started"
    });
    await expect(client.getRun("run_1")).resolves.toEqual({
      runId: "run_1",
      status: "completed",
      output: "done",
      usage: {
        inputTokens: 12,
        outputTokens: 34,
        totalTokens: 46
      }
    });

    expect(requests[0]).toMatchObject({
      url: "https://hermes.example/v1/runs",
      method: "POST",
      authorization: "Bearer secret"
    });
  });
});

describe("HermesAgentToolProvider", () => {
  it("keeps delegation behind one compact non-blocking tool", async () => {
    const client = new HermesAgentClient({
      baseUrl: "https://hermes.example",
      apiKey: "secret",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ run_id: "run_2", status: "started" }),
          { status: 202, headers: { "content-type": "application/json" } }
        )) as typeof fetch
    });
    const provider = new HermesAgentToolProvider(client);

    const tools = await provider.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: "agent_delegate",
      behavior: "non_blocking"
    });

    const result = await provider.callTool(
      {
        name: "agent_delegate",
        arguments: { op: "start", task: "Compare five current options" },
        callId: "h1"
      },
      new AbortController().signal
    );
    expect(result).toMatchObject({
      name: "agent_delegate",
      ok: true,
      callId: "h1",
      value: { runId: "run_2", status: "started" }
    });
  });
});
