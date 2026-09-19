import { describe, expect, it } from "vitest";
import type {
  OpusDecoderPrimitive,
  OpusEncoderPrimitive,
  OpusPrimitiveFactory,
  OpusStreamFormat
} from "../src/audio/codec.js";
import {
  Pcm16FrameAccumulator,
  StreamingOpusCodecFactory
} from "../src/audio/streaming-opus.js";

function pcmChunk(
  bytes: number,
  value: number,
  sampleRate = 24000,
  channels: 1 | 2 = 1
) {
  return {
    format: "pcm16le" as const,
    data: new Uint8Array(bytes).fill(value),
    sampleRate,
    channels
  };
}

class FakeDecoder implements OpusDecoderPrimitive {
  decodeCalls = 0;
  closed = false;

  decode(_packet: Uint8Array): Uint8Array {
    this.decodeCalls += 1;
    return Uint8Array.from([1, 0, 2, 0]);
  }

  close(): void {
    this.closed = true;
  }
}

class FakeEncoder implements OpusEncoderPrimitive {
  readonly frames: Uint8Array[] = [];
  resetCalls = 0;
  closed = false;

  encode(pcmFrame: Uint8Array): Uint8Array {
    this.frames.push(pcmFrame.slice());
    return Uint8Array.from([
      pcmFrame[0] ?? 0,
      pcmFrame[pcmFrame.byteLength - 1] ?? 0
    ]);
  }

  reset(): void {
    this.resetCalls += 1;
  }

  close(): void {
    this.closed = true;
  }
}

class FakePrimitiveFactory implements OpusPrimitiveFactory {
  readonly decoders: FakeDecoder[] = [];
  readonly encoders: FakeEncoder[] = [];

  createDecoder(_format: OpusStreamFormat): OpusDecoderPrimitive {
    const decoder = new FakeDecoder();
    this.decoders.push(decoder);
    return decoder;
  }

  createEncoder(_format: OpusStreamFormat): OpusEncoderPrimitive {
    const encoder = new FakeEncoder();
    this.encoders.push(encoder);
    return encoder;
  }
}

const config = {
  uplink: {
    sampleRate: 16000,
    channels: 1 as const,
    frameDurationMs: 60
  },
  downlink: {
    sampleRate: 24000,
    channels: 1 as const,
    frameDurationMs: 60
  }
};

describe("PCM frame accumulator", () => {
  it("combines three 20 ms provider chunks into one 60 ms device frame", () => {
    const accumulator = new Pcm16FrameAccumulator(config.downlink);

    expect(accumulator.frameBytes).toBe(2880);
    expect(accumulator.push(pcmChunk(960, 1))).toHaveLength(0);
    expect(accumulator.push(pcmChunk(960, 2))).toHaveLength(0);

    const frames = accumulator.push(pcmChunk(960, 3));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.byteLength).toBe(2880);
    expect(frames[0]?.slice(0, 960)).toEqual(new Uint8Array(960).fill(1));
    expect(frames[0]?.slice(960, 1920)).toEqual(new Uint8Array(960).fill(2));
    expect(frames[0]?.slice(1920)).toEqual(new Uint8Array(960).fill(3));
    expect(accumulator.pendingBytes).toBe(0);
  });

  it("preserves leftover PCM across arbitrary provider chunk boundaries", () => {
    const accumulator = new Pcm16FrameAccumulator(config.downlink);

    // 100 ms at 24 kHz mono PCM16 = 4800 bytes.
    const first = accumulator.push(pcmChunk(4800, 7));
    expect(first).toHaveLength(1);
    expect(first[0]?.byteLength).toBe(2880);
    expect(accumulator.pendingBytes).toBe(1920);

    // Another 20 ms completes the second 60 ms frame.
    const second = accumulator.push(pcmChunk(960, 8));
    expect(second).toHaveLength(1);
    expect(second[0]?.slice(0, 1920)).toEqual(new Uint8Array(1920).fill(7));
    expect(second[0]?.slice(1920)).toEqual(new Uint8Array(960).fill(8));
    expect(accumulator.pendingBytes).toBe(0);
  });

  it("rejects mismatched and partial PCM frames", () => {
    const accumulator = new Pcm16FrameAccumulator(config.downlink);

    expect(() => accumulator.push(pcmChunk(960, 1, 16000))).toThrow(
      /sample rate mismatch/
    );
    expect(() =>
      accumulator.push({
        format: "pcm16le",
        data: Uint8Array.from([1]),
        sampleRate: 24000,
        channels: 1
      })
    ).toThrow(/partial sample frame/);
  });
});

describe("streaming Opus codec session", () => {
  it("decodes uplink into explicit provider PCM16 format", async () => {
    const primitives = new FakePrimitiveFactory();
    const factory = new StreamingOpusCodecFactory(primitives);
    const session = await factory.createSession(config);

    const pcm = await session.decodeUplink(Uint8Array.from([0xaa, 0xbb]));

    expect(pcm).toEqual({
      format: "pcm16le",
      data: Uint8Array.from([1, 0, 2, 0]),
      sampleRate: 16000,
      channels: 1
    });
    expect(primitives.decoders[0]?.decodeCalls).toBe(1);
  });

  it("keeps encoder buffering state isolated per device session", async () => {
    const primitives = new FakePrimitiveFactory();
    const factory = new StreamingOpusCodecFactory(primitives);
    const sessionA = await factory.createSession(config);
    const sessionB = await factory.createSession(config);

    expect(await sessionA.encodeDownlink(pcmChunk(1920, 1))).toHaveLength(0);
    expect(await sessionB.encodeDownlink(pcmChunk(960, 9))).toHaveLength(0);

    const packetsA = await sessionA.encodeDownlink(pcmChunk(960, 2));
    expect(packetsA).toEqual([Uint8Array.from([1, 2])]);

    // B still has only its own 20 ms pending; A's 40 ms must not leak into it.
    expect(await sessionB.encodeDownlink(pcmChunk(960, 8))).toHaveLength(0);
    const packetsB = await sessionB.encodeDownlink(pcmChunk(960, 7));
    expect(packetsB).toEqual([Uint8Array.from([9, 7])]);

    expect(primitives.encoders).toHaveLength(2);
    expect(primitives.encoders[0]?.frames).toHaveLength(1);
    expect(primitives.encoders[1]?.frames).toHaveLength(1);
  });

  it("drops partial playback after interruption and closes native state once", async () => {
    const primitives = new FakePrimitiveFactory();
    const factory = new StreamingOpusCodecFactory(primitives);
    const session = await factory.createSession(config);

    expect(await session.encodeDownlink(pcmChunk(1920, 4))).toHaveLength(0);
    await session.resetDownlink();

    // If reset worked, a fresh 20 ms must not complete the discarded 40 ms.
    expect(await session.encodeDownlink(pcmChunk(960, 5))).toHaveLength(0);
    expect(primitives.encoders[0]?.resetCalls).toBe(1);

    await session.close();
    await session.close();
    expect(primitives.decoders[0]?.closed).toBe(true);
    expect(primitives.encoders[0]?.closed).toBe(true);

    await expect(session.decodeUplink(Uint8Array.from([1]))).rejects.toThrow(
      /closed/
    );
  });
});
