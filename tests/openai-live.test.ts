import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "../src/actions/contracts.js";
import type { VoiceSession, VoiceSessionEvent } from "../src/contracts/providers.js";
import {
  OpenAILiveVoiceProvider,
  normalizeOpenAILiveBackendUsage,
  normalizeOpenAILiveSessionUsage,
  type OpenAILiveSocketFactory
} from "../src/providers/voice/openai-live.js";

class FakeOpenAILiveSocket extends EventEmitter {
  readyState = 0;
  readonly sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = true;
    this.readyState = 3;
    this.emit("close", code ?? 1000, Buffer.from(reason ?? ""));
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  message(value: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(value)), false);
  }
}

function createHarness() {
  const sockets: FakeOpenAILiveSocket[] = [];
  const calls: Array<{
    url: string;
    headers: Record<string, string>;
  }> = [];
  const factory: OpenAILiveSocketFactory = (url, headers) => {
    calls.push({ url, headers });
    const socket = new FakeOpenAILiveSocket();
    sockets.push(socket);
    return socket;
  };
  return { sockets, calls, factory };
}

async function connectHarness(
  factory: OpenAILiveSocketFactory,
  sockets: FakeOpenAILiveSocket[],
  tools: ToolDefinition[] = []
) {
  const provider = new OpenAILiveVoiceProvider("openai-live", {
    apiKey: "secret",
    model: "gpt-live-1",
    backendModel: "gpt-5.6-luna",
    voice: "marin",
    systemInstruction: "Be concise.",
    backendInstructions: "Use tools when needed.",
    outputIdleMs: 10,
    closeTimeoutMs: 25,
    socketFactory: factory
  });
  const pending = provider.connect(tools.length > 0 ? { tools } : undefined);
  await Promise.resolve();

  const socket = sockets[0]!;
  socket.open();
  expect(JSON.parse(socket.sent[0]!)).toMatchObject({
    type: "session.start"
  });
  socket.message({
    type: "session.started",
    session: { id: "live-session" }
  });

  return {
    provider,
    session: await pending,
    socket
  };
}

async function closeHarness(
  session: VoiceSession,
  socket: FakeOpenAILiveSocket
): Promise<void> {
  const closing = session.close();
  await Promise.resolve();
  expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
    type: "session.close"
  });
  socket.message({ type: "session.closed" });
  await closing;
}

describe("OpenAI Live provider", () => {
  it("starts GPT-Live with native 16 kHz PCM and sequential Responses tools", async () => {
    const harness = createHarness();
    const tools: ToolDefinition[] = [
      {
        name: "web_search",
        description: "Search the web.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" }
          },
          required: ["query"],
          additionalProperties: false
        },
        effect: "read"
      }
    ];
    const { session, socket } = await connectHarness(
      harness.factory,
      harness.sockets,
      tools
    );

    try {
      expect(harness.calls).toEqual([
        {
          url: "wss://api.openai.com/v1/live/sessions",
          headers: {
            Authorization: "Bearer secret"
          }
        }
      ]);
      expect(JSON.parse(socket.sent[0]!)).toEqual({
        type: "session.start",
        session: {
          model: "gpt-live-1",
          instructions: "Be concise.",
          audio: {
            format: {
              type: "audio/pcm",
              rate: 16000
            },
            output: {
              voice: "marin"
            }
          },
          delegation: {
            type: "responses",
            responses: {
              model: "gpt-5.6-luna",
              instructions: "Use tools when needed.",
              tools: [
                {
                  type: "function",
                  name: "web_search",
                  description: "Search the web.",
                  parameters: tools[0]!.inputSchema
                }
              ],
              tool_choice: "auto",
              parallel_tool_calls: false
            }
          }
        }
      });
    } finally {
      await closeHarness(session, socket);
    }
  });

  it("streams native PCM input and maps output audio/transcripts to Nara events", async () => {
    const harness = createHarness();
    const { session, socket } = await connectHarness(
      harness.factory,
      harness.sockets
    );
    const events: VoiceSessionEvent[] = [];
    const unsubscribe = session.subscribe((event) => {
      events.push(event);
    });

    try {
      await session.sendAudio({
        format: "pcm16le",
        data: Uint8Array.from([1, 0, 2, 0]),
        sampleRate: 16000,
        channels: 1
      });
      expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
        type: "session.input_audio.append",
        audio: Buffer.from([1, 0, 2, 0]).toString("base64")
      });

      socket.message({
        type: "session.input_transcript.delta",
        delta: "halo "
      });
      socket.message({
        type: "session.input_transcript.delta",
        delta: "nara"
      });
      socket.message({
        type: "session.output_audio.delta",
        delta: Buffer.from([3, 0, 4, 0]).toString("base64")
      });
      socket.message({
        type: "session.output_transcript.delta",
        delta: "Hai."
      });

      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(events).toContainEqual({
        type: "input.transcript",
        text: "halo nara",
        final: true
      });
      expect(events).toContainEqual({ type: "output.started" });
      expect(events).toContainEqual({
        type: "audio",
        chunk: {
          format: "pcm16le",
          data: Uint8Array.from([3, 0, 4, 0]),
          sampleRate: 16000,
          channels: 1
        }
      });
      expect(events).toContainEqual({
        type: "output.transcript",
        text: "Hai.",
        final: true
      });
      expect(events).toContainEqual({
        type: "output.completed"
      });

      await expect(
        session.sendAudio({
          format: "pcm16le",
          data: Uint8Array.from([1, 0]),
          sampleRate: 24000,
          channels: 1
        })
      ).rejects.toThrow(/16 kHz/);
    } finally {
      unsubscribe();
      await closeHarness(session, socket);
    }
  });

  it("round-trips delegated function calls through Nara Action Runtime results", async () => {
    const harness = createHarness();
    const tools: ToolDefinition[] = [
      {
        name: "device_status",
        description: "Read device status.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        effect: "read"
      }
    ];
    const { session, socket } = await connectHarness(
      harness.factory,
      harness.sockets,
      tools
    );
    const events: VoiceSessionEvent[] = [];
    const unsubscribe = session.subscribe((event) => {
      events.push(event);
    });

    try {
      socket.message({
        type: "response.event",
        delegation_id: "delegation-1",
        event: {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            call_id: "call-1",
            name: "device_status",
            arguments: "{}"
          }
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(events).toContainEqual({
        type: "tool.call",
        name: "device_status",
        arguments: {},
        callId: "call-1"
      });

      await session.sendToolResult?.({
        name: "device_status",
        callId: "call-1",
        ok: true,
        value: { battery: 82 }
      });

      expect(
        socket.sent.slice(-2).map((value) => JSON.parse(value))
      ).toEqual([
        {
          type: "response.item.create",
          item: {
            type: "function_call_output",
            call_id: "call-1",
            output: "{\"battery\":82}"
          }
        },
        {
          type: "response.create"
        }
      ]);
    } finally {
      unsubscribe();
      await closeHarness(session, socket);
    }
  });

  it("injects remote text through the delegated Responses conversation", async () => {
    const harness = createHarness();
    const { session, socket } = await connectHarness(
      harness.factory,
      harness.sockets
    );

    try {
      await session.sendText?.("halo dari telegram");
      expect(
        socket.sent.slice(-2).map((value) => JSON.parse(value))
      ).toEqual([
        {
          type: "response.item.create",
          item: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "halo dari telegram"
              }
            ]
          }
        },
        {
          type: "response.create"
        }
      ]);
    } finally {
      await closeHarness(session, socket);
    }
  });

  it("interrupts spoken output without cancelling pending Nara tool work", async () => {
    const harness = createHarness();
    const { session, socket } = await connectHarness(
      harness.factory,
      harness.sockets
    );
    const events: VoiceSessionEvent[] = [];
    const unsubscribe = session.subscribe((event) => {
      events.push(event);
    });

    try {
      socket.message({
        type: "response.event",
        event: {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            call_id: "slow-tool",
            name: "web_search",
            arguments: "{\"query\":\"latest\"}"
          }
        }
      });
      socket.message({
        type: "session.output_transcript.delta",
        delta: "Sebentar,"
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      const sentBeforeInterrupt = socket.sent.length;
      await session.interrupt();

      expect(
        events.filter((event) => event.type === "tool.cancel")
      ).toHaveLength(0);
      expect(events).toContainEqual({ type: "interrupted" });
      expect(socket.sent).toHaveLength(sentBeforeInterrupt);

      await session.sendToolResult?.({
        name: "web_search",
        callId: "slow-tool",
        ok: true,
        value: { answer: "done" }
      });
      expect(
        socket.sent.slice(-2).map((value) => JSON.parse(value))
      ).toEqual([
        {
          type: "response.item.create",
          item: {
            type: "function_call_output",
            call_id: "slow-tool",
            output: "{\"answer\":\"done\"}"
          }
        },
        { type: "response.create" }
      ]);
    } finally {
      unsubscribe();
      await closeHarness(session, socket);
    }
  });

  it("reports cumulative GPT-Live voice duration without double-counting snapshots", async () => {
    const harness = createHarness();
    const { session, socket } = await connectHarness(
      harness.factory,
      harness.sockets
    );
    const events: VoiceSessionEvent[] = [];
    const unsubscribe = session.subscribe((event) => {
      events.push(event);
    });

    try {
      socket.message({
        type: "session.usage.updated",
        usage: { seconds: 12 }
      });
      socket.message({
        type: "session.usage.updated",
        usage: { seconds: 12 }
      });
      socket.message({
        type: "session.usage.updated",
        usage: { seconds: 15 }
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(
        events.filter((event) => event.type === "usage")
      ).toEqual([
        { type: "usage", usage: { voiceSeconds: 12 } },
        { type: "usage", usage: { voiceSeconds: 15 } }
      ]);
    } finally {
      unsubscribe();
      await closeHarness(session, socket);
    }
  });

  it("normalizes delegated Responses usage", async () => {
    const harness = createHarness();
    const { session, socket } = await connectHarness(
      harness.factory,
      harness.sockets
    );
    const events: VoiceSessionEvent[] = [];
    const unsubscribe = session.subscribe((event) => {
      events.push(event);
    });

    try {
      socket.message({
        type: "response.event",
        event: {
          type: "response.completed",
          response: {
            id: "resp-usage-1",
            usage: {
              input_tokens: 100,
              output_tokens: 20,
              total_tokens: 120,
              input_tokens_details: {
                cached_tokens: 60
              }
            }
          }
        }
      });
      socket.message({
        type: "response.event",
        event: {
          type: "response.completed",
          response: {
            id: "resp-usage-1",
            usage: {
              input_tokens: 100,
              output_tokens: 20,
              total_tokens: 120,
              input_tokens_details: {
                cached_tokens: 60
              }
            }
          }
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(
        events.filter((event) => event.type === "usage")
      ).toHaveLength(1);
      expect(events).toContainEqual({
        type: "usage",
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          cachedInputTokens: 60,
          uncachedInputTokens: 40
        }
      });
    } finally {
      unsubscribe();
      await closeHarness(session, socket);
    }
  });
});

describe("OpenAI Live usage normalization", () => {
  it("normalizes cumulative live-session seconds", () => {
    expect(
      normalizeOpenAILiveSessionUsage({ seconds: 12.5 })
    ).toEqual({ voiceSeconds: 12.5 });
    expect(normalizeOpenAILiveSessionUsage({ seconds: -1 }))
      .toBeUndefined();
  });

  it("derives uncached backend input tokens", () => {
    expect(
      normalizeOpenAILiveBackendUsage({
        input_tokens: 500,
        output_tokens: 50,
        input_tokens_details: {
          cached_tokens: 320
        }
      })
    ).toEqual({
      inputTokens: 500,
      outputTokens: 50,
      totalTokens: 550,
      cachedInputTokens: 320,
      uncachedInputTokens: 180
    });
  });
});
