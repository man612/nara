import { describe, expect, it } from "vitest";
import { createEncoder } from "libopus-wasm";
import { createLibopusWasmCodecFactory } from "../src/audio/libopus-wasm.js";

function makeSinePcm(
  sampleRate: number,
  durationMs: number,
  frequencyHz = 440
): Uint8Array {
  const samples = Math.round((sampleRate * durationMs) / 1000);
  const bytes = new Uint8Array(samples * 2);
  const view = new DataView(bytes.buffer);

  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(
      Math.sin((2 * Math.PI * frequencyHz * index) / sampleRate) * 12000
    );
    view.setInt16(index * 2, value, true);
  }

  return bytes;
}

function pcmEnergy(data: Uint8Array): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let energy = 0;
  for (let offset = 0; offset < data.byteLength; offset += 2) {
    energy += Math.abs(view.getInt16(offset, true));
  }
  return energy;
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

describe("libopus-wasm codec", () => {
  it("encodes 24 kHz provider PCM into one 60 ms device Opus packet", async () => {
    const session = await createLibopusWasmCodecFactory().createSession(config);

    try {
      const pcm = makeSinePcm(24000, 60);
      const packets = await session.encodeDownlink({
        format: "pcm16le",
        data: pcm,
        sampleRate: 24000,
        channels: 1
      });

      expect(packets).toHaveLength(1);
      expect(packets[0]?.byteLength).toBeGreaterThan(0);
      expect(packets[0]?.byteLength).toBeLessThan(pcm.byteLength);
    } finally {
      await session.close();
    }
  });

  it("decodes a real 16 kHz 60 ms Opus uplink packet to PCM16", async () => {
    const uplinkEncoder = await createEncoder({
      sampleRate: 16000,
      channels: 1,
      frameSize: 960
    });
    const session = await createLibopusWasmCodecFactory().createSession(config);

    try {
      const source = makeSinePcm(16000, 60);
      // Prime codec state so the assertion measures decoded speech rather than
      // only Opus algorithmic lookahead on the first packet.
      for (let index = 0; index < 3; index += 1) {
        uplinkEncoder.encode(source);
      }

      const packet = uplinkEncoder.encode(source);
      const decoded = await session.decodeUplink(packet);

      expect(decoded.format).toBe("pcm16le");
      expect(decoded.sampleRate).toBe(16000);
      expect(decoded.channels).toBe(1);
      expect(decoded.data.byteLength).toBe(1920);
      expect(pcmEnergy(decoded.data)).toBeGreaterThan(10000);
    } finally {
      uplinkEncoder.free();
      await session.close();
    }
  });

  it("recreates the playback encoder after interruption", async () => {
    const session = await createLibopusWasmCodecFactory().createSession(config);

    try {
      expect(
        await session.encodeDownlink({
          format: "pcm16le",
          data: makeSinePcm(24000, 40),
          sampleRate: 24000,
          channels: 1
        })
      ).toHaveLength(0);

      await session.resetDownlink();

      // The discarded 40 ms must not combine with this fresh 20 ms.
      expect(
        await session.encodeDownlink({
          format: "pcm16le",
          data: makeSinePcm(24000, 20),
          sampleRate: 24000,
          channels: 1
        })
      ).toHaveLength(0);

      const packets = await session.encodeDownlink({
        format: "pcm16le",
        data: makeSinePcm(24000, 40),
        sampleRate: 24000,
        channels: 1
      });
      expect(packets).toHaveLength(1);
      expect(packets[0]?.byteLength).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  });
});
