import type {
  AudioChunk,
  SpeechRequestOptions,
  TextToSpeechProvider
} from "../../contracts/providers.js";

export type OpenAICompatibleTtsConfig = {
  id: string;
  baseUrl: string;
  model: string;
  voice: string;
  apiKey?: string;
  sampleRate?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_SAMPLE_RATE = 24_000;
const MAX_TEXT_LENGTH = 4_096;
const MAX_AUDIO_BYTES = 16 * 1024 * 1024;

export class OpenAICompatibleTts implements TextToSpeechProvider {
  readonly id: string;

  constructor(private readonly config: OpenAICompatibleTtsConfig) {
    this.id = config.id;
  }

  async synthesize(
    textInput: string,
    options: SpeechRequestOptions = {}
  ): Promise<AudioChunk> {
    const text = textInput.trim();
    if (!text) throw new Error("TTS text must not be empty");
    if (text.length > MAX_TEXT_LENGTH) {
      throw new Error(`TTS text exceeds ${MAX_TEXT_LENGTH} characters`);
    }

    const baseUrl = this.config.baseUrl.trim().replace(/\/+$/, "");
    if (!baseUrl) throw new Error("TTS base URL is required");

    const timeoutSignal = AbortSignal.timeout(
      this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;

    const response = await (this.config.fetchImpl ?? fetch)(
      `${baseUrl}/audio/speech`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.config.apiKey
            ? { authorization: `Bearer ${this.config.apiKey}` }
            : {})
        },
        body: JSON.stringify({
          model: this.config.model,
          voice: this.config.voice,
          input: text,
          response_format: "pcm"
        }),
        signal
      }
    );

    if (!response.ok) {
      throw new Error(
        `${this.id} failed: ${response.status} ${await response.text()}`
      );
    }

    const data = new Uint8Array(await response.arrayBuffer());
    if (
      data.byteLength === 0 ||
      data.byteLength % 2 !== 0 ||
      data.byteLength > MAX_AUDIO_BYTES
    ) {
      throw new Error(`${this.id} returned invalid PCM16 audio`);
    }

    const sampleRate = this.config.sampleRate ?? DEFAULT_SAMPLE_RATE;
    if (
      !Number.isInteger(sampleRate) ||
      sampleRate < 8_000 ||
      sampleRate > 192_000
    ) {
      throw new Error("TTS sample rate is invalid");
    }

    return {
      format: "pcm16le",
      data,
      sampleRate,
      channels: 1
    };
  }
}
