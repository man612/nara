import type {
  AudioChunk,
  SpeechRequestOptions,
  SpeechToTextProvider
} from "../../contracts/providers.js";

export type OpenAICompatibleSttConfig = {
  id: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  language?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

function pcm16Wav(audio: AudioChunk): Uint8Array {
  if (
    audio.format !== "pcm16le" ||
    audio.data.byteLength === 0 ||
    audio.data.byteLength % 2 !== 0
  ) {
    throw new Error("STT input must contain PCM16LE whole samples");
  }
  if (audio.channels !== 1 && audio.channels !== 2) {
    throw new Error("STT input must be mono or stereo PCM");
  }
  if (
    !Number.isInteger(audio.sampleRate) ||
    audio.sampleRate < 8_000 ||
    audio.sampleRate > 192_000
  ) {
    throw new Error("STT input sample rate is invalid");
  }
  if (audio.data.byteLength > MAX_AUDIO_BYTES) {
    throw new Error("STT input exceeds the bounded turn size");
  }

  const dataLength = audio.data.byteLength;
  const blockAlign = audio.channels * 2;
  const byteRate = audio.sampleRate * blockAlign;
  const wav = Buffer.alloc(44 + dataLength);

  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataLength, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(audio.channels, 22);
  wav.writeUInt32LE(audio.sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataLength, 40);
  Buffer.from(
    audio.data.buffer,
    audio.data.byteOffset,
    audio.data.byteLength
  ).copy(wav, 44);

  return Uint8Array.from(wav);
}

export class OpenAICompatibleStt implements SpeechToTextProvider {
  readonly id: string;

  constructor(private readonly config: OpenAICompatibleSttConfig) {
    this.id = config.id;
  }

  async transcribe(
    audio: AudioChunk,
    options: SpeechRequestOptions = {}
  ): Promise<string> {
    const baseUrl = this.config.baseUrl.trim().replace(/\/+$/, "");
    if (!baseUrl) throw new Error("STT base URL is required");

    const form = new FormData();
    form.append(
      "file",
      new Blob([pcm16Wav(audio)], { type: "audio/wav" }),
      "nara-turn.wav"
    );
    form.append("model", this.config.model);
    form.append("response_format", "json");
    if (this.config.language) {
      form.append("language", this.config.language);
    }

    const timeoutSignal = AbortSignal.timeout(
      this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;

    const response = await (this.config.fetchImpl ?? fetch)(
      `${baseUrl}/audio/transcriptions`,
      {
        method: "POST",
        headers: {
          ...(this.config.apiKey
            ? { authorization: `Bearer ${this.config.apiKey}` }
            : {})
        },
        body: form,
        signal
      }
    );

    if (!response.ok) {
      throw new Error(
        `${this.id} failed: ${response.status} ${await response.text()}`
      );
    }

    const body = (await response.json()) as { text?: unknown };
    if (typeof body.text !== "string") {
      throw new Error(`${this.id} returned an invalid transcription response`);
    }
    return body.text.trim();
  }
}
