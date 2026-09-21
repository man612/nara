import type {
  VoiceConnectOptions,
  VoiceProvider,
  VoiceSession
} from "../../contracts/providers.js";

export type VoiceProviderCandidate = {
  id: string;
  create: () => VoiceProvider;
};

export class FallbackVoiceProvider implements VoiceProvider {
  readonly id: string;

  constructor(
    id: string,
    private readonly candidates: VoiceProviderCandidate[]
  ) {
    if (candidates.length === 0) {
      throw new Error("FallbackVoiceProvider needs at least one candidate");
    }
    this.id = id;
  }

  async connect(options?: VoiceConnectOptions): Promise<VoiceSession> {
    const failures: string[] = [];

    for (const candidate of this.candidates) {
      try {
        const provider = candidate.create();
        return await provider.connect(options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${candidate.id}: ${message}`);
      }
    }

    throw new Error(`All voice providers failed: ${failures.join(" | ")}`);
  }
}
