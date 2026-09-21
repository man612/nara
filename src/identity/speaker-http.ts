import type {
  SpeakerIdentityProvider,
  SpeakerProviderResult,
  SpeakerPcmAudio,
  SpeakerProfileRef
} from "./speaker.js";

const DEFAULT_TIMEOUT_MS = 8_000;

function wavFromPcm16(audio: SpeakerPcmAudio): Uint8Array {
  if (audio.sampleRate <= 0 || !Number.isFinite(audio.sampleRate)) {
    throw new Error("speaker audio sampleRate must be positive");
  }

  const pcmBytes = audio.pcm16.byteLength;
  const output = new Uint8Array(44 + pcmBytes);
  const view = new DataView(output.buffer);

  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      output[offset + index] = value.charCodeAt(index);
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + pcmBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, audio.sampleRate, true);
  view.setUint32(28, audio.sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, pcmBytes, true);

  for (let index = 0; index < audio.pcm16.length; index += 1) {
    view.setInt16(44 + index * 2, audio.pcm16[index] ?? 0, true);
  }
  return output;
}

function parseScores(
  value: unknown,
  candidates: SpeakerProfileRef[]
): SpeakerProviderResult {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Array.isArray((value as { scores?: unknown }).scores)
  ) {
    throw new Error("Speaker identity service returned invalid scores");
  }

  const allowed = new Set(candidates.map((candidate) => candidate.profileId));
  const seen = new Set<string>();
  const scores = (value as { scores: unknown[] }).scores.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Speaker score must be an object");
    }

    const profileId = (item as { profileId?: unknown }).profileId;
    const score = (item as { score?: unknown }).score;
    if (
      typeof profileId !== "string" ||
      !allowed.has(profileId) ||
      seen.has(profileId) ||
      typeof score !== "number" ||
      !Number.isFinite(score) ||
      score < 0 ||
      score > 1
    ) {
      throw new Error("Speaker identity service returned an invalid candidate");
    }
    seen.add(profileId);
    return { profileId, score };
  });

  return { scores };
}

export class HttpSpeakerIdentityProvider implements SpeakerIdentityProvider {
  readonly id: string;

  constructor(
    private readonly endpoint: string,
    private readonly options: {
      bearerToken?: string;
      timeoutMs?: number;
      fetchImpl?: typeof fetch;
    } = {}
  ) {
    const url = new URL(endpoint);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("Speaker identity endpoint must use HTTP(S)");
    }
    this.id = `speaker-http:${url.host}`;
  }

  async identify(
    input: {
      audio: SpeakerPcmAudio;
      candidates: SpeakerProfileRef[];
    },
    signal: AbortSignal
  ): Promise<SpeakerProviderResult> {
    if (input.candidates.length === 0) return { scores: [] };

    const form = new FormData();
    const wav = wavFromPcm16(input.audio);
    form.set("audio", new Blob([wav], { type: "audio/wav" }), "utterance.wav");
    form.set(
      "candidates",
      JSON.stringify(input.candidates.map((candidate) => ({
        profileId: candidate.profileId
      })))
    );

    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const combined = AbortSignal.any([signal, timeout]);
    const headers: Record<string, string> = {};
    if (this.options.bearerToken) {
      headers.authorization = `Bearer ${this.options.bearerToken}`;
    }

    const response = await (this.options.fetchImpl ?? fetch)(this.endpoint, {
      method: "POST",
      headers,
      body: form,
      signal: combined
    });
    if (!response.ok) {
      throw new Error(`Speaker identity service failed with HTTP ${response.status}`);
    }

    return parseScores(await response.json(), input.candidates);
  }
}
