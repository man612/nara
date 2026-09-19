import type {
  BrainProvider,
  BrainRequest,
  BrainResponse
} from "../../contracts/providers.js";

export class FallbackBrainProvider implements BrainProvider {
  readonly id: string;

  constructor(
    id: string,
    private readonly providers: BrainProvider[]
  ) {
    if (providers.length === 0) {
      throw new Error("FallbackBrainProvider needs at least one provider");
    }
    this.id = id;
  }

  async complete(request: BrainRequest): Promise<BrainResponse> {
    const failures: string[] = [];

    for (const provider of this.providers) {
      try {
        const response = await provider.complete(request);
        return {
          ...response,
          providerId: response.providerId ?? provider.id
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${provider.id}: ${message}`);
      }
    }

    throw new Error(`All brain providers failed: ${failures.join(" | ")}`);
  }
}
