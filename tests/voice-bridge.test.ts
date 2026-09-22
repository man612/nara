import { describe, expect, it } from "vitest";
import type {
  AudioCodecFactory,
  AudioCodecSession,
  AudioCodecSessionConfig
} from "../src/audio/codec.js";
import type {
  AudioChunk,
  VoiceConnectOptions,
  VoiceEventHandler,
  VoiceProvider,
  VoiceSession,
  VoiceSessionEvent
} from "../src/contracts/providers.js";
import { FirmwareVoiceBridge } from "../src/device/voice-bridge.js";
import type {
  FirmwareSessionInfo,
  FirmwareSessionTransport
} from "../src/gateway.js";

class FakeCodecSession implements AudioCodecSession {
  readonly decoded: Uint8Array[] = [];
  readonly encoded: AudioChunk[] = [];
  resetCalls = 0;
  flushCalls = 0;
  closed = false;

  async decodeUplink(packet: Uint8Array): Promise<AudioChunk> {
    this.decoded.push(packet.slice());
    return {
      format: "pcm16le",
      data: Uint8Array.from([1, 0, 2, 0]),
      sampleRate: 16000,
      channels: 1
    };
  }

  async encodeDownlink(chunk: AudioChunk): Promise<Uint8Array[]> {
    this.encoded.push({
      ...chunk,
      data: chunk.data.slice()
    });
    return [Uint8Array.from([0xaa, chunk.data[0] ?? 0])];
  }

  async flushDownlink(): Promise<Uint8Array[]> {
    this.flushCalls += 1;
    return [];
  }

  async resetDownlink(): Promise<void> {
    this.resetCalls += 1;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeCodecFactory implements AudioCodecFactory {
  readonly session = new FakeCodecSession();
  config: AudioCodecSessionConfig | null = null;

  async createSession(config: AudioCodecSessionConfig): Promise<AudioCodecSession> {
    this.config = config;
    return this.session;
  }
}

class FakeVoiceSession implements VoiceSession {
  readonly handlers = new Set<VoiceEventHandler>();
  readonly input: AudioChunk[] = [];
  readonly toolResults: unknown[] = [];
  interruptCalls = 0;
  streamEndCalls = 0;
  closed = false;

  async sendAudio(chunk: AudioChunk): Promise<void> {
    this.input.push({
      ...chunk,
      data: chunk.data.slice()
    });
  }

  async endAudioStream(): Promise<void> {
    this.streamEndCalls += 1;
  }

  async sendToolResult(result: unknown): Promise<void> {
    this.toolResults.push(result);
  }

  async interrupt(): Promise<void> {
    this.interruptCalls += 1;
  }

  subscribe(handler: VoiceEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async emit(event: VoiceSessionEvent): Promise<void> {
    for (const handler of [...this.handlers]) {
      await handler(event);
    }
  }
}

class FakeVoiceProvider implements VoiceProvider {
  readonly id = "fake";
  readonly session = new FakeVoiceSession();
  connectOptions: VoiceConnectOptions | undefined;

  async connect(options?: VoiceConnectOptions): Promise<VoiceSession> {
    this.connectOptions = options;
    return this.session;
  }
}

function createFirmwareSession(mcp = false): FirmwareSessionInfo {
  return {
    sessionId: "session-1",
    protocolVersion: 2,
    hello: {
      type: "hello",
      version: 2,
      transport: "websocket",
      ...(mcp ? { features: { mcp: true } } : {}),
      audio_params: {
        format: "opus",
        sample_rate: 16000,
        channels: 1,
        frame_duration: 60
      }
    }
  };
}

function createTransport() {
  const log: Array<
    | { type: "json"; value: unknown }
    | { type: "audio"; value: Uint8Array }
  > = [];

  const transport: FirmwareSessionTransport = {
    playback: {
      format: "opus",
      sample_rate: 24000,
      channels: 1,
      frame_duration: 60
    },
    sendJson(message) {
      log.push({ type: "json", value: message });
    },
    sendAudio(payload) {
      log.push({ type: "audio", value: payload.slice() });
    },
    close() {}
  };

  return { log, transport };
}

function providerAudio(value = 7): VoiceSessionEvent {
  return {
    type: "audio",
    chunk: {
      format: "pcm16le",
      data: Uint8Array.from([value, 0]),
      sampleRate: 24000,
      channels: 1
    }
  };
}

describe("FirmwareVoiceBridge", () => {
  it("decodes firmware Opus into provider PCM and sends tts start before playback audio", async () => {
    const codecFactory = new FakeCodecFactory();
    const voiceProvider = new FakeVoiceProvider();
    const { log, transport } = createTransport();
    const bridge = new FirmwareVoiceBridge({
      codecFactory,
      voiceProvider
    });

    const handler = await bridge.createSession(
      createFirmwareSession(),
      transport
    );

    await handler.onAudio({
      payload: Uint8Array.from([0xf8, 0xff]),
      timestamp: 123
    });

    expect(codecFactory.config).toEqual({
      uplink: {
        sampleRate: 16000,
        channels: 1,
        frameDurationMs: 60
      },
      downlink: {
        sampleRate: 24000,
        channels: 1,
        frameDurationMs: 60
      }
    });
    expect(voiceProvider.session.input).toEqual([
      {
        format: "pcm16le",
        data: Uint8Array.from([1, 0, 2, 0]),
        sampleRate: 16000,
        channels: 1
      }
    ]);

    await voiceProvider.session.emit(providerAudio(9));

    expect(log).toEqual([
      {
        type: "json",
        value: {
          type: "tts",
          state: "start",
          session_id: "session-1"
        }
      },
      {
        type: "audio",
        value: Uint8Array.from([0xaa, 9])
      }
    ]);

    await voiceProvider.session.emit({ type: "output.completed" });

    expect(log.at(-1)).toEqual({
      type: "json",
      value: {
        type: "tts",
        state: "stop",
        session_id: "session-1"
      }
    });

    await handler.close();
  });

  it("maps manual microphone stop to provider audioStreamEnd", async () => {
    const codecFactory = new FakeCodecFactory();
    const voiceProvider = new FakeVoiceProvider();
    const { transport } = createTransport();
    const bridge = new FirmwareVoiceBridge({
      codecFactory,
      voiceProvider
    });
    const handler = await bridge.createSession(
      createFirmwareSession(),
      transport
    );

    await handler.onEvent({
      type: "listen",
      state: "stop",
      session_id: "session-1"
    });

    expect(voiceProvider.session.streamEndCalls).toBe(1);
    await handler.close();
  });

  it("stops playback on abort and suppresses stale provider audio until interruption is confirmed", async () => {
    const codecFactory = new FakeCodecFactory();
    const voiceProvider = new FakeVoiceProvider();
    const { log, transport } = createTransport();
    const bridge = new FirmwareVoiceBridge({
      codecFactory,
      voiceProvider
    });
    const handler = await bridge.createSession(
      createFirmwareSession(),
      transport
    );

    await voiceProvider.session.emit(providerAudio(1));
    await handler.onEvent({
      type: "abort",
      session_id: "session-1"
    });

    expect(voiceProvider.session.interruptCalls).toBe(1);
    expect(codecFactory.session.resetCalls).toBe(1);
    expect(log.at(-1)).toEqual({
      type: "json",
      value: {
        type: "tts",
        state: "stop",
        session_id: "session-1"
      }
    });

    const entriesAfterAbort = log.length;
    await voiceProvider.session.emit(providerAudio(2));
    expect(log).toHaveLength(entriesAfterAbort);

    await voiceProvider.session.emit({ type: "interrupted" });
    expect(codecFactory.session.resetCalls).toBe(2);

    await voiceProvider.session.emit(providerAudio(3));
    expect(log.slice(-2)).toEqual([
      {
        type: "json",
        value: {
          type: "tts",
          state: "start",
          session_id: "session-1"
        }
      },
      {
        type: "audio",
        value: Uint8Array.from([0xaa, 3])
      }
    ]);

    await handler.close();
  });

  it("forwards final transcripts, usage and tool calls without leaking provider types into firmware audio", async () => {
    const codecFactory = new FakeCodecFactory();
    const voiceProvider = new FakeVoiceProvider();
    const { log, transport } = createTransport();
    const usage: unknown[] = [];
    const tools: unknown[] = [];
    const bridge = new FirmwareVoiceBridge({
      codecFactory,
      voiceProvider,
      onUsage: (_session, value) => {
        usage.push(value);
      },
      onToolCall: (_session, value) => {
        tools.push(value);
      }
    });
    const handler = await bridge.createSession(
      createFirmwareSession(),
      transport
    );

    await voiceProvider.session.emit({
      type: "input.transcript",
      text: "halo nara",
      final: true
    });
    await voiceProvider.session.emit({
      type: "usage",
      usage: { totalTokens: 42 }
    });
    await voiceProvider.session.emit({
      type: "tool.call",
      name: "light",
      arguments: { on: true },
      callId: "tool-1"
    });

    expect(log).toEqual([
      {
        type: "json",
        value: {
          type: "stt",
          text: "halo nara",
          session_id: "session-1"
        }
      }
    ]);
    expect(usage).toEqual([{ totalTokens: 42 }]);
    expect(tools).toEqual([
      {
        type: "tool.call",
        name: "light",
        arguments: { on: true },
        callId: "tool-1"
      }
    ]);

    await handler.close();
  });

  it("suppresses a provider tool result after that call is cancelled", async () => {
    const codecFactory = new FakeCodecFactory();
    const voiceProvider = new FakeVoiceProvider();
    const { log, transport } = createTransport();
    const bridge = new FirmwareVoiceBridge({
      codecFactory,
      voiceProvider
    });
    const handler = await bridge.createSession(
      createFirmwareSession(true),
      transport
    );

    await voiceProvider.session.emit({
      type: "tool.call",
      name: "device_set_volume",
      arguments: { volume: 30 },
      callId: "cancel-me"
    });

    expect(log.at(-1)).toMatchObject({
      type: "json",
      value: {
        type: "mcp",
        payload: {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize"
        }
      }
    });

    await voiceProvider.session.emit({
      type: "tool.cancel",
      callIds: ["cancel-me"]
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(voiceProvider.session.toolResults).toHaveLength(0);
    await handler.close();
  });


  it("exposes server-side session tools even when the firmware has no MCP support", async () => {
    const codecFactory = new FakeCodecFactory();
    const voiceProvider = new FakeVoiceProvider();
    const { transport } = createTransport();
    const calls: unknown[] = [];

    const bridge = new FirmwareVoiceBridge({
      codecFactory,
      voiceProvider,
      createToolProviders: () => [
        {
          id: "server-tool",
          async listTools() {
            return [
              {
                name: "server_lookup",
                description: "Lookup server-side context.",
                inputSchema: {
                  type: "object",
                  properties: {
                    query: { type: "string" }
                  },
                  required: ["query"],
                  additionalProperties: false
                },
                effect: "read" as const
              }
            ];
          },
          async callTool(call) {
            calls.push(call);
            return {
              name: call.name,
              ok: true,
              ...(call.callId ? { callId: call.callId } : {}),
              value: { answer: "server-only" },
              scheduling: "silent" as const
            };
          }
        }
      ]
    });

    const handler = await bridge.createSession(
      createFirmwareSession(false),
      transport
    );

    expect(voiceProvider.connectOptions?.tools).toEqual([
      expect.objectContaining({
        name: "server_lookup",
        effect: "read"
      })
    ]);

    await voiceProvider.session.emit({
      type: "tool.call",
      name: "server_lookup",
      arguments: { query: "hello" },
      callId: "server-1"
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toEqual([
      {
        name: "server_lookup",
        arguments: { query: "hello" },
        callId: "server-1"
      }
    ]);
    expect(voiceProvider.session.toolResults).toEqual([
      {
        name: "server_lookup",
        ok: true,
        callId: "server-1",
        value: { answer: "server-only" },
        scheduling: "silent"
      }
    ]);

    await handler.close();
  });

  it("hides sensitive session tools until an explicit session authorizer is installed", async () => {
    const sensitiveProvider = (calls: unknown[]) => ({
      id: "external",
      async listTools() {
        return [
          {
            name: "external_sensitive",
            description: "Perform a sensitive external action.",
            inputSchema: {
              type: "object",
              properties: {
                target: { type: "string" }
              },
              required: ["target"],
              additionalProperties: false
            },
            effect: "sensitive" as const
          }
        ];
      },
      async callTool(call: {
        name: string;
        arguments: unknown;
        callId?: string;
      }) {
        calls.push(call);
        return {
          name: call.name,
          ok: true,
          ...(call.callId ? { callId: call.callId } : {}),
          value: { done: true }
        };
      }
    });

    {
      const codecFactory = new FakeCodecFactory();
      const voiceProvider = new FakeVoiceProvider();
      const { transport } = createTransport();
      const calls: unknown[] = [];
      const bridge = new FirmwareVoiceBridge({
        codecFactory,
        voiceProvider,
        createToolProviders: () => [sensitiveProvider(calls)]
      });
      const handler = await bridge.createSession(
        createFirmwareSession(),
        transport
      );

      expect(voiceProvider.connectOptions?.tools).toEqual([]);
      expect(calls).toEqual([]);
      await handler.close();
    }

    {
      const codecFactory = new FakeCodecFactory();
      const voiceProvider = new FakeVoiceProvider();
      const { transport } = createTransport();
      const calls: unknown[] = [];
      const authorizations: unknown[] = [];
      const bridge = new FirmwareVoiceBridge({
        codecFactory,
        voiceProvider,
        createToolProviders: () => [sensitiveProvider(calls)],
        authorizeTool: (session, request) => {
          authorizations.push({
            sessionId: session.sessionId,
            providerId: request.providerId,
            name: request.call.name,
            effect: request.definition.effect
          });
          return { allowed: true };
        }
      });
      const handler = await bridge.createSession(
        createFirmwareSession(),
        transport
      );

      expect(voiceProvider.connectOptions?.tools).toEqual([
        expect.objectContaining({
          name: "external_sensitive",
          effect: "sensitive"
        })
      ]);

      await voiceProvider.session.emit({
        type: "tool.call",
        name: "external_sensitive",
        arguments: { target: "item-1" },
        callId: "sensitive-1"
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(authorizations).toEqual([
        {
          sessionId: "session-1",
          providerId: "external",
          name: "external_sensitive",
          effect: "sensitive"
        }
      ]);
      expect(calls).toEqual([
        {
          name: "external_sensitive",
          arguments: { target: "item-1" },
          callId: "sensitive-1"
        }
      ]);
      expect(voiceProvider.session.toolResults).toEqual([
        {
          name: "external_sensitive",
          ok: true,
          callId: "sensitive-1",
          value: { done: true }
        }
      ]);

      await handler.close();
    }
  });

  it("closes both codec and provider session exactly at the firmware boundary", async () => {
    const codecFactory = new FakeCodecFactory();
    const voiceProvider = new FakeVoiceProvider();
    const { transport } = createTransport();
    const bridge = new FirmwareVoiceBridge({
      codecFactory,
      voiceProvider
    });
    const handler = await bridge.createSession(
      createFirmwareSession(),
      transport
    );

    await handler.close();
    await handler.close();

    expect(codecFactory.session.closed).toBe(true);
    expect(voiceProvider.session.closed).toBe(true);
    expect(voiceProvider.session.handlers.size).toBe(0);
  });
});
