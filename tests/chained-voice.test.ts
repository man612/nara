import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "../src/actions/contracts.js";
import type {
  AudioChunk,
  BrainProvider,
  BrainRequest,
  BrainResponse,
  SpeechToTextProvider,
  TextToSpeechProvider,
  VoiceSessionEvent
} from "../src/contracts/providers.js";
import { ChainedVoiceProvider } from "../src/providers/voice/chained.js";

class FakeStt implements SpeechToTextProvider {
  readonly id = "stt";
  readonly inputs: AudioChunk[] = [];

  async transcribe(audio: AudioChunk): Promise<string> {
    this.inputs.push({
      ...audio,
      data: Uint8Array.from(audio.data)
    });
    return "tolong cek status";
  }
}

class FakeBrain implements BrainProvider {
  readonly id = "brain";
  readonly requests: BrainRequest[] = [];

  async complete(request: BrainRequest): Promise<BrainResponse> {
    this.requests.push(structuredClone(request));

    if (this.requests.length === 1) {
      return {
        text: "",
        toolCalls: [
          {
            id: "tool-1",
            name: "device_status",
            arguments: {}
          }
        ],
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 12
        }
      };
    }

    return {
      text: "Status perangkat normal.",
      usage: {
        inputTokens: 20,
        outputTokens: 5,
        totalTokens: 25
      }
    };
  }
}

class FakeTts implements TextToSpeechProvider {
  readonly id = "tts";
  readonly texts: string[] = [];

  async synthesize(text: string): Promise<AudioChunk> {
    this.texts.push(text);
    return {
      format: "pcm16le",
      data: Uint8Array.from([1, 0, 2, 0]),
      sampleRate: 24_000,
      channels: 1
    };
  }
}

function timeout(ms = 1_000): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error("test timed out")), ms);
  });
}

describe("ChainedVoiceProvider", () => {
  it("runs STT -> brain -> Action Runtime tool -> brain -> TTS", async () => {
    const stt = new FakeStt();
    const brain = new FakeBrain();
    const tts = new FakeTts();
    const provider = new ChainedVoiceProvider("chained", {
      stt,
      brain,
      tts,
      systemInstruction: "Be concise."
    });
    const tools: ToolDefinition[] = [
      {
        name: "device_status",
        description: "Read device status.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false
        },
        effect: "read",
        behavior: "blocking"
      }
    ];
    const session = await provider.connect({ tools });
    const events: VoiceSessionEvent[] = [];

    let resolveCompleted!: () => void;
    const completed = new Promise<void>((resolve) => {
      resolveCompleted = resolve;
    });

    const unsubscribe = session.subscribe(async (event) => {
      events.push(event);
      if (event.type === "tool.call") {
        await session.sendToolResult?.({
          name: event.name,
          callId: event.callId!,
          ok: true,
          value: { answer: "server-only" }
        });
      }
      if (event.type === "output.completed") {
        resolveCompleted();
      }
    });

    try {
      await session.sendAudio({
        format: "pcm16le",
        data: Uint8Array.from([1, 0, 2, 0]),
        sampleRate: 16_000,
        channels: 1
      });
      await session.endAudioStream?.();
      await Promise.race([completed, timeout()]);

      expect(stt.inputs).toHaveLength(1);
      expect(brain.requests).toHaveLength(2);
      expect(brain.requests[0]?.tools).toEqual([
        {
          type: "function",
          function: {
            name: "device_status",
            description: "Read device status.",
            parameters: tools[0]!.inputSchema
          }
        }
      ]);
      expect(brain.requests[1]?.messages).toContainEqual({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tool-1",
            name: "device_status",
            arguments: {}
          }
        ]
      });
      expect(brain.requests[1]?.messages).toContainEqual({
        role: "tool",
        name: "device_status",
        toolCallId: "tool-1",
        content: "{\"answer\":\"server-only\"}"
      });
      expect(tts.texts).toEqual(["Status perangkat normal."]);

      expect(events).toContainEqual({ type: "speech.started" });
      expect(events).toContainEqual({ type: "speech.stopped" });
      expect(events).toContainEqual({
        type: "input.transcript",
        text: "tolong cek status",
        final: true
      });
      expect(events).toContainEqual({
        type: "tool.call",
        name: "device_status",
        arguments: {},
        callId: "tool-1"
      });
      expect(events).toContainEqual({
        type: "output.transcript",
        text: "Status perangkat normal.",
        final: true
      });
      expect(events).toContainEqual({
        type: "audio",
        chunk: {
          format: "pcm16le",
          data: Uint8Array.from([1, 0, 2, 0]),
          sampleRate: 24_000,
          channels: 1
        }
      });
      expect(
        events.filter((event) => event.type === "usage")
      ).toHaveLength(2);
    } finally {
      unsubscribe();
      await session.close();
    }
  });

  it("aborts an in-flight chained turn on interruption", async () => {
    const stt: SpeechToTextProvider = {
      id: "slow-stt",
      async transcribe(_audio, options) {
        return new Promise<string>((_resolve, reject) => {
          const signal = options?.signal;
          if (!signal) {
            reject(new Error("missing signal"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => reject(signal.reason),
            { once: true }
          );
        });
      }
    };
    const brain = new FakeBrain();
    const tts = new FakeTts();
    const session = await new ChainedVoiceProvider("chained", {
      stt,
      brain,
      tts
    }).connect();
    const events: VoiceSessionEvent[] = [];
    const unsubscribe = session.subscribe((event) => {
      events.push(event);
    });

    try {
      await session.sendAudio({
        format: "pcm16le",
        data: Uint8Array.from([1, 0]),
        sampleRate: 16_000,
        channels: 1
      });
      await session.endAudioStream?.();
      await Promise.resolve();
      await session.interrupt();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(events).toContainEqual({ type: "interrupted" });
      expect(brain.requests).toHaveLength(0);
      expect(tts.texts).toHaveLength(0);
    } finally {
      unsubscribe();
      await session.close();
    }
  });
});
