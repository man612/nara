import type { AudioChunk } from "../contracts/providers.js";
import type {
  AudioCodecFactory,
  AudioCodecSession,
  AudioCodecSessionConfig,
  OpusDecoderPrimitive,
  OpusEncoderPrimitive,
  OpusPrimitiveFactory,
  OpusStreamFormat
} from "./codec.js";

const BYTES_PER_PCM16_SAMPLE = 2;

function assertFormat(format: OpusStreamFormat, label: string): void {
  if (!Number.isInteger(format.sampleRate) || format.sampleRate <= 0) {
    throw new Error(`${label} sample rate must be a positive integer`);
  }
  if (format.channels !== 1 && format.channels !== 2) {
    throw new Error(`${label} channels must be 1 or 2`);
  }
  if (!Number.isFinite(format.frameDurationMs) || format.frameDurationMs <= 0) {
    throw new Error(`${label} frame duration must be positive`);
  }

  const samplesPerFrame = (format.sampleRate * format.frameDurationMs) / 1000;
  if (!Number.isInteger(samplesPerFrame)) {
    throw new Error(`${label} frame duration does not produce an integer sample count`);
  }
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right.slice();
  if (right.byteLength === 0) return left.slice();

  const joined = new Uint8Array(left.byteLength + right.byteLength);
  joined.set(left, 0);
  joined.set(right, left.byteLength);
  return joined;
}

export class Pcm16FrameAccumulator {
  readonly frameBytes: number;
  private pending = new Uint8Array(0);

  constructor(readonly format: OpusStreamFormat) {
    assertFormat(format, "PCM accumulator");
    const samplesPerFrame = (format.sampleRate * format.frameDurationMs) / 1000;
    this.frameBytes =
      samplesPerFrame * format.channels * BYTES_PER_PCM16_SAMPLE;
  }

  get pendingBytes(): number {
    return this.pending.byteLength;
  }

  push(chunk: AudioChunk): Uint8Array[] {
    if (chunk.format !== "pcm16le") {
      throw new Error(`Unsupported PCM format: ${chunk.format}`);
    }
    if (chunk.sampleRate !== this.format.sampleRate) {
      throw new Error(
        `PCM sample rate mismatch: expected ${this.format.sampleRate}, got ${chunk.sampleRate}`
      );
    }
    if (chunk.channels !== this.format.channels) {
      throw new Error(
        `PCM channel mismatch: expected ${this.format.channels}, got ${chunk.channels}`
      );
    }

    const sampleFrameBytes =
      chunk.channels * BYTES_PER_PCM16_SAMPLE;
    if (chunk.data.byteLength % sampleFrameBytes !== 0) {
      throw new Error("PCM16 chunk ends in a partial sample frame");
    }

    const data = concatBytes(this.pending, chunk.data);
    const frames: Uint8Array[] = [];
    let offset = 0;

    while (data.byteLength - offset >= this.frameBytes) {
      frames.push(data.slice(offset, offset + this.frameBytes));
      offset += this.frameBytes;
    }

    this.pending = data.slice(offset);
    return frames;
  }

  reset(): void {
    this.pending = new Uint8Array(0);
  }
}

export class StreamingOpusCodecSession implements AudioCodecSession {
  private readonly downlinkAccumulator: Pcm16FrameAccumulator;
  private closed = false;

  constructor(
    private readonly config: AudioCodecSessionConfig,
    private readonly decoder: OpusDecoderPrimitive,
    private readonly encoder: OpusEncoderPrimitive
  ) {
    assertFormat(config.uplink, "Opus uplink");
    assertFormat(config.downlink, "Opus downlink");
    this.downlinkAccumulator = new Pcm16FrameAccumulator(config.downlink);
  }

  async decodeUplink(packet: Uint8Array): Promise<AudioChunk> {
    this.assertOpen();
    if (packet.byteLength === 0) {
      throw new Error("Cannot decode an empty Opus packet");
    }

    const pcm = this.decoder.decode(packet);
    const sampleFrameBytes =
      this.config.uplink.channels * BYTES_PER_PCM16_SAMPLE;

    if (pcm.byteLength === 0 || pcm.byteLength % sampleFrameBytes !== 0) {
      throw new Error("Opus decoder returned invalid PCM16 byte length");
    }

    return {
      format: "pcm16le",
      data: pcm,
      sampleRate: this.config.uplink.sampleRate,
      channels: this.config.uplink.channels
    };
  }

  async encodeDownlink(chunk: AudioChunk): Promise<Uint8Array[]> {
    this.assertOpen();
    const frames = this.downlinkAccumulator.push(chunk);
    return frames.map((frame) => {
      const packet = this.encoder.encode(frame);
      if (packet.byteLength === 0) {
        throw new Error("Opus encoder returned an empty packet");
      }
      return packet;
    });
  }

  async resetDownlink(): Promise<void> {
    this.assertOpen();
    this.downlinkAccumulator.reset();
    await this.encoder.reset?.();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.downlinkAccumulator.reset();
    await Promise.all([
      this.decoder.close?.(),
      this.encoder.close?.()
    ]);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("Audio codec session is closed");
    }
  }
}

export class StreamingOpusCodecFactory implements AudioCodecFactory {
  constructor(private readonly primitives: OpusPrimitiveFactory) {}

  async createSession(
    config: AudioCodecSessionConfig
  ): Promise<AudioCodecSession> {
    assertFormat(config.uplink, "Opus uplink");
    assertFormat(config.downlink, "Opus downlink");

    const [decoder, encoder] = await Promise.all([
      this.primitives.createDecoder(config.uplink),
      this.primitives.createEncoder(config.downlink)
    ]);

    return new StreamingOpusCodecSession(config, decoder, encoder);
  }
}
