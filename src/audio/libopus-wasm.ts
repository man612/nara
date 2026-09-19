import {
  Application,
  Signal,
  createDecoder,
  createEncoder,
  type ChannelCount,
  type OpusDecoderHandle,
  type OpusEncoderHandle,
  type SampleRate
} from "libopus-wasm";
import type {
  OpusDecoderPrimitive,
  OpusEncoderPrimitive,
  OpusPrimitiveFactory,
  OpusStreamFormat
} from "./codec.js";
import { StreamingOpusCodecFactory } from "./streaming-opus.js";

const SUPPORTED_SAMPLE_RATES = new Set<number>([
  8000,
  12000,
  16000,
  24000,
  48000
]);

function asSampleRate(value: number): SampleRate {
  if (!SUPPORTED_SAMPLE_RATES.has(value)) {
    throw new Error(`Unsupported Opus sample rate: ${value}`);
  }
  return value as SampleRate;
}

function asChannelCount(value: 1 | 2): ChannelCount {
  return value;
}

function samplesPerFrame(format: OpusStreamFormat): number {
  const samples = (format.sampleRate * format.frameDurationMs) / 1000;
  if (!Number.isInteger(samples)) {
    throw new Error("Opus frame duration must produce an integer sample count");
  }
  return samples;
}

function pcmBytes(samples: Int16Array): Uint8Array {
  return new Uint8Array(
    samples.buffer,
    samples.byteOffset,
    samples.byteLength
  ).slice();
}

class LibopusWasmDecoder implements OpusDecoderPrimitive {
  private handle: OpusDecoderHandle | null;

  constructor(handle: OpusDecoderHandle) {
    this.handle = handle;
  }

  decode(packet: Uint8Array): Uint8Array {
    const handle = this.requireHandle();
    return pcmBytes(handle.decode(packet));
  }

  close(): void {
    if (this.handle === null) return;
    this.handle.free();
    this.handle = null;
  }

  private requireHandle(): OpusDecoderHandle {
    if (this.handle === null) {
      throw new Error("Opus decoder is closed");
    }
    return this.handle;
  }
}

class LibopusWasmEncoder implements OpusEncoderPrimitive {
  private handle: OpusEncoderHandle | null;

  private constructor(
    private readonly format: OpusStreamFormat,
    handle: OpusEncoderHandle
  ) {
    this.handle = handle;
  }

  static async create(format: OpusStreamFormat): Promise<LibopusWasmEncoder> {
    return new LibopusWasmEncoder(
      format,
      await LibopusWasmEncoder.createHandle(format)
    );
  }

  encode(pcmFrame: Uint8Array): Uint8Array {
    return this.requireHandle().encode(pcmFrame);
  }

  async reset(): Promise<void> {
    const previous = this.handle;
    this.handle = null;
    previous?.free();

    this.handle = await LibopusWasmEncoder.createHandle(this.format);
  }

  close(): void {
    if (this.handle === null) return;
    this.handle.free();
    this.handle = null;
  }

  private requireHandle(): OpusEncoderHandle {
    if (this.handle === null) {
      throw new Error("Opus encoder is closed or resetting");
    }
    return this.handle;
  }

  private static async createHandle(
    format: OpusStreamFormat
  ): Promise<OpusEncoderHandle> {
    return createEncoder({
      application: Application.Voip,
      bitrate: 32000,
      channels: asChannelCount(format.channels),
      complexity: 10,
      dtx: false,
      fec: false,
      frameSize: samplesPerFrame(format),
      sampleRate: asSampleRate(format.sampleRate),
      signal: Signal.Voice,
      vbr: true
    });
  }
}

export class LibopusWasmPrimitiveFactory implements OpusPrimitiveFactory {
  async createDecoder(
    format: OpusStreamFormat
  ): Promise<OpusDecoderPrimitive> {
    const handle = await createDecoder({
      channels: asChannelCount(format.channels),
      maxFrameSize: Math.floor(format.sampleRate * 0.12),
      sampleRate: asSampleRate(format.sampleRate)
    });
    return new LibopusWasmDecoder(handle);
  }

  async createEncoder(
    format: OpusStreamFormat
  ): Promise<OpusEncoderPrimitive> {
    return LibopusWasmEncoder.create(format);
  }
}

export function createLibopusWasmCodecFactory(): StreamingOpusCodecFactory {
  return new StreamingOpusCodecFactory(new LibopusWasmPrimitiveFactory());
}
