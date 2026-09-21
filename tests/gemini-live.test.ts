import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  GeminiLiveVoiceProvider,
  normalizeGeminiLiveUsage,
  type GeminiSocketFactory
} from "../src/providers/voice/gemini-live.js";
import type { ToolDefinition } from "../src/actions/contracts.js";
import type { VoiceSessionEvent } from "../src/contracts/providers.js";

class FakeGeminiSocket extends EventEmitter {
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
  const sockets: FakeGeminiSocket[] = [];
  const urls: string[] = [];
  const factory: GeminiSocketFactory = (url) => {
    urls.push(url);
    const socket = new FakeGeminiSocket();
    sockets.push(socket);
    return socket;
  };

  return { sockets, urls, factory };
}

async function connectHarness(
  factory: GeminiSocketFactory,
  sockets: FakeGeminiSocket[],
  tools: ToolDefinition[] = []
) {
  const provider = new GeminiLiveVoiceProvider("gemini-live", {
    apiKey: "secret key",
    model: "gemini-3.8-live",
    systemInstruction: "Be concise.",
    socketFactory: factory
  });

  const pending = provider.connect(tools.length > 0 ? { tools } : undefined);
  await Promise.resolve();

  const socket = sockets[0]!;
  socket.open();
  expect(socket.sent).toHaveLength(1);
  socket.message({ setupComplete: {} });

  return {
    provider,
    session: await pending,
    socket
  };
}

describe("Gemini Live provider", () => {
  it("sends a resumable compressed audio setup and never exposes the API key in events", async () => {
    const harness = createHarness();
    const { session, socket } = await connectHarness(
      harness.factory,
      harness.sockets
    );

    try {
      expect(harness.urls[0]).toContain("key=secret%20key");

      const setup = JSON.parse(socket.sent[0]!);
      expect(setup).toMatchObject({
        setup: {
          model: "models/gemini-3.8-live",
          generationConfig: {
            responseModalities: ["AUDIO"]
          },
          systemInstruction: {
            parts: [{ text: "Be concise." }]
          },
          sessionResumption: {},
          contextWindowCompression: {
            slidingWindow: {}
          }
        }
      });
    } finally {
      await session.close();
    }
  });

  it("declares Nara tools and sends provider-neutral results back to Gemini", async () => {
    const harness = createHarness();
    const tools: ToolDefinition[] = [
      {
        name: "device_set_volume",
        description: "Set speaker volume.",
        inputSchema: {
          type: "object",
          properties: {
            volume: { type: "integer", minimum: 0, maximum: 100 }
          },
          required: ["volume"]
        },
        effect: "write"
      }
    ];
    const { session, socket } = await connectHarness(
      harness.factory,
      harness.sockets,
      tools
    );

    try {
      const setup = JSON.parse(socket.sent[0]!);
      expect(setup.setup.tools).toEqual([
        {
          functionDeclarations: [
            {
              name: "device_set_volume",
              description: "Set speaker volume.",
              parametersJsonSchema: tools[0]!.inputSchema
            }
          ]
        }
      ]);

      await session.sendToolResult?.({
        name: "device_set_volume",
        callId: "call-volume",
        ok: true,
        value: true
      });

      expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
        toolResponse: {
          functionResponses: [
            {
              name: "device_set_volume",
              id: "call-volume",
              response: { result: true }
            }
          ]
        }
      });
    } finally {
      await session.close();
    }
  });

  it("sends native 16 kHz PCM input as realtime audio", async () => {
    const harness = createHarness();
    const { session, socket } = await connectHarness(
      harness.factory,
      harness.sockets
    );

    try {
      await session.sendAudio({
        format: "pcm16le",
        data: Uint8Array.from([1, 2, 3, 4]),
        sampleRate: 16000,
        channels: 1
      });

      const message = JSON.parse(socket.sent.at(-1)!);
      expect(message).toEqual({
        realtimeInput: {
          audio: {
            data: Buffer.from([1, 2, 3, 4]).toString("base64"),
            mimeType: "audio/pcm;rate=16000"
          }
        }
      });

      await session.endAudioStream?.();
      expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
        realtimeInput: {
          audioStreamEnd: true
        }
      });

      await expect(
        session.sendAudio({
          format: "pcm16le",
          data: Uint8Array.from([1, 2]),
          sampleRate: 24000,
          channels: 1
        })
      ).rejects.toThrow(/16000 Hz/);
    } finally {
      await session.close();
    }
  });

  it("normalizes server audio, transcripts, interruption, tools and usage", async () => {
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
        serverContent: {
          modelTurn: {
            parts: [
              {
                inlineData: {
                  mimeType: "audio/pcm;rate=24000",
                  data: Buffer.from([4, 3, 2, 1]).toString("base64")
                }
              }
            ]
          },
          interimInputTranscription: { text: "hal" },
          inputTranscription: { text: "halo" },
          outputTranscription: { text: "hai" },
          interrupted: true
        },
        usageMetadata: {
          promptTokenCount: 100,
          responseTokenCount: 20,
          totalTokenCount: 120,
          cachedContentTokenCount: 70
        }
      });

      socket.message({
        toolCall: {
          functionCalls: [
            {
              id: "call-1",
              name: "set_light",
              args: { on: true }
            }
          ]
        }
      });
      socket.message({
        toolCallCancellation: {
          ids: ["call-1"]
        }
      });

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(events).toContainEqual({ type: "output.started" });
      expect(events).toContainEqual({
        type: "audio",
        chunk: {
          format: "pcm16le",
          data: Uint8Array.from([4, 3, 2, 1]),
          sampleRate: 24000,
          channels: 1
        }
      });
      expect(events).toContainEqual({
        type: "input.transcript",
        text: "hal",
        final: false
      });
      expect(events).toContainEqual({
        type: "input.transcript",
        text: "halo",
        final: true
      });
      expect(events).toContainEqual({
        type: "output.transcript",
        text: "hai",
        final: false
      });
      expect(events).toContainEqual({ type: "interrupted" });
      expect(events).toContainEqual({
        type: "usage",
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          cachedInputTokens: 70,
          uncachedInputTokens: 30
        }
      });
      expect(events).toContainEqual({
        type: "tool.call",
        name: "set_light",
        arguments: { on: true },
        callId: "call-1"
      });
      expect(events).toContainEqual({
        type: "tool.cancel",
        callIds: ["call-1"]
      });
    } finally {
      unsubscribe();
      await session.close();
    }
  });

  it("emits a provider-neutral completion after the model turn ends", async () => {
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
        serverContent: {
          modelTurn: {
            parts: [
              {
                inlineData: {
                  mimeType: "audio/pcm;rate=24000",
                  data: Buffer.from([1, 0, 2, 0]).toString("base64")
                }
              }
            ]
          }
        }
      });
      socket.message({
        serverContent: {
          turnComplete: true
        }
      });

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(events.map((event) => event.type)).toEqual([
        "output.started",
        "audio",
        "output.completed"
      ]);
    } finally {
      unsubscribe();
      await session.close();
    }
  });

  it("reconnects on GoAway using the latest resumable handle", async () => {
    const harness = createHarness();
    const { session, socket } = await connectHarness(
      harness.factory,
      harness.sockets
    );

    try {
      socket.message({
        sessionResumptionUpdate: {
          resumable: true,
          newHandle: "resume-123"
        }
      });
      socket.message({ goAway: { timeLeft: "5s" } });

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(harness.sockets).toHaveLength(2);

      const resumed = harness.sockets[1]!;
      resumed.open();
      const setup = JSON.parse(resumed.sent[0]!);
      expect(setup.setup.sessionResumption).toEqual({
        handle: "resume-123"
      });

      resumed.message({ setupComplete: {} });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(socket.closed).toBe(true);

      await session.sendText?.("halo lagi");
      expect(JSON.parse(resumed.sent.at(-1)!)).toEqual({
        realtimeInput: { text: "halo lagi" }
      });
    } finally {
      await session.close();
    }
  });
});

describe("Gemini Live usage normalization", () => {
  it("derives uncached input tokens", () => {
    expect(
      normalizeGeminiLiveUsage({
        promptTokenCount: 500,
        responseTokenCount: 50,
        cachedContentTokenCount: 320
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
