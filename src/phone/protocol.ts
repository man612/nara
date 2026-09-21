import type { AudioChunk } from "../contracts/providers.js";

const MAGIC = [0x4e, 0x50, 0x31, 0x36] as const; // NP16
const HEADER_BYTES = 12;

export function encodePhonePcmFrame(chunk: AudioChunk): Uint8Array {
  if (chunk.format !== "pcm16le" || chunk.channels !== 1) {
    throw new Error("Phone audio frame requires mono PCM16LE");
  }
  if (chunk.data.byteLength % 2 !== 0) {
    throw new Error("Phone PCM payload must contain complete 16-bit samples");
  }

  const output = new Uint8Array(HEADER_BYTES + chunk.data.byteLength);
  output.set(MAGIC, 0);
  const view = new DataView(output.buffer);
  view.setUint32(4, chunk.sampleRate, true);
  view.setUint8(8, chunk.channels);
  output.set(chunk.data, HEADER_BYTES);
  return output;
}

export function decodePhonePcmFrame(data: Uint8Array): AudioChunk {
  if (
    data.byteLength < HEADER_BYTES ||
    MAGIC.some((value, index) => data[index] !== value)
  ) {
    throw new Error("Invalid phone PCM frame");
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const sampleRate = view.getUint32(4, true);
  const channels = view.getUint8(8);
  if (channels !== 1 || sampleRate !== 16000) {
    throw new Error("Phone uplink must be mono PCM16LE at 16 kHz");
  }
  const payload = data.slice(HEADER_BYTES);
  if (payload.byteLength === 0 || payload.byteLength % 2 !== 0) {
    throw new Error("Invalid phone PCM payload");
  }
  return {
    format: "pcm16le",
    data: payload,
    sampleRate,
    channels: 1
  };
}
