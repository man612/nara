import type {
  SearchOptions,
  SearchProvider,
  SearchResult,
} from "../../contracts/providers.js";

export class FallbackSearchProvider implements SearchProvider {
  readonly id: string;

  constructor(
    id: string,
    private readonly providers: SearchProvider[],
  ) {
    if (providers.length === 0) {
      throw new Error("FallbackSearchProvider needs at least one provider");
    }
    this.id = id;
  }

  async search(
    query: string,
    options: SearchOptions = {},
  ): Promise<SearchResult[]> {
    const failures: string[] = [];

    for (const provider of this.providers) {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new Error("Search cancelled");
      }

      try {
        return await provider.search(query, options);
      } catch (error) {
        if (options.signal?.aborted) {
          throw options.signal.reason ?? error;
        }
        failures.push(
          `${provider.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    throw new Error(`All search providers failed: ${failures.join(" | ")}`);
  }
}
