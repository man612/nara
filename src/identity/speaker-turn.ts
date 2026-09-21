import type { AudioChunk } from "../contracts/providers.js";
import type {
  SpeakerIdentityDecision,
  SpeakerIdentityService
} from "./speaker.js";

type SpeakerIdentityResolver = Pick<SpeakerIdentityService, "identify">;

export type SpeakerTurnRecognizerOptions = {
  preRollMs?: number;
  maxUtteranceMs?: number;
};

function chunkToPcm16(chunk: AudioChunk): Int16Array {
  if (chunk.format !== "pcm16le" || chunk.channels !== 1) {
    throw new Error("Speaker recognition requires mono PCM16LE");
  }
  if (chunk.data.byteLength % 2 !== 0) {
    throw new Error("PCM16LE chunk must contain complete 16-bit samples");
  }

  const view = new DataView(
    chunk.data.buffer,
    chunk.data.byteOffset,
    chunk.data.byteLength
  );
  const samples = new Int16Array(chunk.data.byteLength / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true);
  }
  return samples;
}

function concatenate(chunks: Int16Array[]): Int16Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Int16Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function trimTail(chunks: Int16Array[], maxSamples: number): Int16Array[] {
  let remaining = maxSamples;
  const kept: Int16Array[] = [];

  for (let index = chunks.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const chunk = chunks[index]!;
    if (chunk.length <= remaining) {
      kept.unshift(chunk);
      remaining -= chunk.length;
    } else {
      kept.unshift(chunk.slice(chunk.length - remaining));
      remaining = 0;
    }
  }

  return kept;
}

export class SpeakerTurnRecognizer {
  private preRoll: Int16Array[] = [];
  private utterance: Int16Array[] = [];
  private sampleRate: number | undefined;
  private active = false;
  private closed = false;

  constructor(
    private readonly service: SpeakerIdentityResolver,
    private readonly options: SpeakerTurnRecognizerOptions = {}
  ) {}

  pushAudio(chunk: AudioChunk): void {
    if (this.closed) return;
    if (this.sampleRate !== undefined && this.sampleRate !== chunk.sampleRate) {
      this.reset();
    }
    this.sampleRate = chunk.sampleRate;

    const pcm = chunkToPcm16(chunk);
    const preRollSamples = Math.max(
      0,
      Math.floor((chunk.sampleRate * (this.options.preRollMs ?? 400)) / 1000)
    );

    if (this.active) {
      this.utterance.push(pcm);
      const maxSamples = Math.max(
        1,
        Math.floor((chunk.sampleRate * (this.options.maxUtteranceMs ?? 8_000)) / 1000)
      );
      this.utterance = trimTail(this.utterance, maxSamples);
    }

    this.preRoll.push(pcm);
    this.preRoll = trimTail(this.preRoll, preRollSamples);
  }

  speechStarted(): void {
    if (this.closed || this.active) return;
    this.active = true;
    this.utterance = this.preRoll.map((chunk) => chunk.slice());
  }

  async speechStopped(
    signal = new AbortController().signal
  ): Promise<SpeakerIdentityDecision | undefined> {
    if (this.closed || !this.active || this.sampleRate === undefined) {
      return undefined;
    }

    this.active = false;
    const pcm16 = concatenate(this.utterance);
    const sampleRate = this.sampleRate;
    this.utterance = [];

    return this.service.identify({ pcm16, sampleRate }, signal);
  }

  reset(): void {
    this.active = false;
    this.preRoll = [];
    this.utterance = [];
    this.sampleRate = undefined;
  }

  close(): void {
    this.closed = true;
    this.reset();
  }
}
