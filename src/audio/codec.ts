import type { AudioChunk } from "../contracts/providers.js";

export type OpusStreamFormat = {
  sampleRate: number;
  channels: 1 | 2;
  frameDurationMs: number;
};

export type AudioCodecSessionConfig = {
  uplink: OpusStreamFormat;
  downlink: OpusStreamFormat;
};

export interface AudioCodecSession {
  /**
   * Decode one device Opus packet into provider-facing PCM16 little-endian.
   * Decoder history belongs to this session and must never be shared across devices.
   */
  decodeUplink(packet: Uint8Array): Promise<AudioChunk>;

  /**
   * Accept arbitrary provider PCM chunks and emit zero or more complete Opus
   * packets matching the device playback frame duration.
   */
  encodeDownlink(chunk: AudioChunk): Promise<Uint8Array[]>;

  /**
   * Discard partial playback PCM after interruption/abort so stale audio cannot
   * leak into the next response.
   */
  resetDownlink(): void;

  close(): Promise<void>;
}

export interface AudioCodecFactory {
  createSession(config: AudioCodecSessionConfig): Promise<AudioCodecSession>;
}

export interface OpusDecoderPrimitive {
  decode(packet: Uint8Array): Uint8Array;
  reset?(): void;
  close?(): void;
}

export interface OpusEncoderPrimitive {
  encode(pcmFrame: Uint8Array): Uint8Array;
  reset?(): void;
  close?(): void;
}

export interface OpusPrimitiveFactory {
  createDecoder(format: OpusStreamFormat): OpusDecoderPrimitive;
  createEncoder(format: OpusStreamFormat): OpusEncoderPrimitive;
}
