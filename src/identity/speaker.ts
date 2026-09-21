import type { PersonDirectory, SpeakerProfileRef } from "./directory.js";

export type SpeakerPcmAudio = {
  pcm16: Int16Array;
  sampleRate: number;
};

export type SpeakerCandidateScore = {
  profileId: string;
  score: number;
};

export type SpeakerProviderResult = {
  scores: SpeakerCandidateScore[];
};

export interface SpeakerIdentityProvider {
  readonly id: string;

  identify(
    input: {
      audio: SpeakerPcmAudio;
      candidates: SpeakerProfileRef[];
    },
    signal: AbortSignal
  ): Promise<SpeakerProviderResult>;
}

export type SpeakerIdentityPolicy = {
  minConfidence: number;
  minMargin: number;
  minAudioMs: number;
};

export type SpeakerIdentityDecision =
  | {
      kind: "known";
      personId: string;
      confidence: number;
      margin: number;
      providerId: string;
    }
  | {
      kind: "unknown";
      reason:
        | "no_profiles"
        | "audio_too_short"
        | "provider_empty"
        | "below_threshold"
        | "ambiguous";
      providerId: string;
      bestConfidence?: number;
      margin?: number;
    };

function assertProbability(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be between 0 and 1`);
  }
}

function validatePolicy(policy: SpeakerIdentityPolicy): void {
  assertProbability(policy.minConfidence, "minConfidence");
  assertProbability(policy.minMargin, "minMargin");
  if (!Number.isFinite(policy.minAudioMs) || policy.minAudioMs <= 0) {
    throw new Error("minAudioMs must be positive");
  }
}

export class SpeakerIdentityService {
  constructor(
    private readonly provider: SpeakerIdentityProvider,
    private readonly directory: PersonDirectory,
    private readonly policy: SpeakerIdentityPolicy
  ) {
    validatePolicy(policy);
  }

  async identify(
    audio: SpeakerPcmAudio,
    signal = new AbortController().signal
  ): Promise<SpeakerIdentityDecision> {
    if (!Number.isFinite(audio.sampleRate) || audio.sampleRate <= 0) {
      throw new Error("audio sampleRate must be positive");
    }

    const candidates = this.directory.getSpeakerCandidates();
    if (candidates.length === 0) {
      return {
        kind: "unknown",
        reason: "no_profiles",
        providerId: this.provider.id
      };
    }

    const durationMs = (audio.pcm16.length / audio.sampleRate) * 1000;
    if (durationMs < this.policy.minAudioMs) {
      return {
        kind: "unknown",
        reason: "audio_too_short",
        providerId: this.provider.id
      };
    }

    const result = await this.provider.identify(
      {
        audio,
        candidates
      },
      signal
    );

    const allowed = new Map(
      candidates.map((candidate) => [candidate.profileId, candidate.personId])
    );

    const normalized = result.scores.map((candidate) => {
      if (!allowed.has(candidate.profileId)) {
        throw new Error(
          `Speaker provider returned unknown profile ${candidate.profileId}`
        );
      }
      assertProbability(candidate.score, "speaker score");
      return candidate;
    });

    normalized.sort((a, b) => b.score - a.score);
    const best = normalized[0];
    if (!best) {
      return {
        kind: "unknown",
        reason: "provider_empty",
        providerId: this.provider.id
      };
    }

    const second = normalized[1];
    const margin = second ? best.score - second.score : best.score;

    if (best.score < this.policy.minConfidence) {
      return {
        kind: "unknown",
        reason: "below_threshold",
        providerId: this.provider.id,
        bestConfidence: best.score,
        margin
      };
    }

    if (margin < this.policy.minMargin) {
      return {
        kind: "unknown",
        reason: "ambiguous",
        providerId: this.provider.id,
        bestConfidence: best.score,
        margin
      };
    }

    return {
      kind: "known",
      personId: allowed.get(best.profileId)!,
      confidence: best.score,
      margin,
      providerId: this.provider.id
    };
  }
}
