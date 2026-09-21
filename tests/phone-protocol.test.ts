import { describe, expect, it } from "vitest";
import {
  decodePhonePcmFrame,
  encodePhonePcmFrame
} from "../src/phone/protocol.js";

describe("phone PCM protocol", () => {
  it("round-trips mono 16k PCM16LE", () => {
    const chunk = {
      format: "pcm16le" as const,
      data: new Uint8Array([1, 0, 255, 127, 0, 128]),
      sampleRate: 16000,
      channels: 1 as const
    };
    expect(decodePhonePcmFrame(encodePhonePcmFrame(chunk))).toEqual(chunk);
  });

  it("rejects a phone uplink with the wrong sample rate", () => {
    const frame = encodePhonePcmFrame({
      format: "pcm16le",
      data: new Uint8Array([1, 0]),
      sampleRate: 24000,
      channels: 1
    });
    expect(() => decodePhonePcmFrame(frame)).toThrow(/16 kHz/);
  });
});
