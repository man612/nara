import type {
  SearchOptions,
  SearchProvider,
  SearchResult,
} from "../../contracts/providers.js";

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

type SearxngResult = {
  title?: unknown;
  url?: unknown;
  content?: unknown;
};

type SearxngResponse = {
  results?: unknown;
};

export type SearxngSearchOptions = {
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export class SearxngSearchProvider implements SearchProvider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(id: string, options: SearxngSearchOptions) {
    const baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
    if (!baseUrl) {
      throw new Error("SearXNG base URL is required");
    }
    this.id = id;
    this.baseUrl = baseUrl;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async search(
    queryInput: string,
    options: SearchOptions = {},
  ): Promise<SearchResult[]> {
    const query = queryInput.trim();
    if (!query) {
      throw new Error("Search query must not be empty");
    }

    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Math.trunc(options.limit ?? DEFAULT_LIMIT)),
    );
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;

    const url = new URL(this.baseUrl + "/search");
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    url.searchParams.set("safesearch", "1");

    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/json",
      },
      signal,
    });

    if (!response.ok) {
      const detail =
        response.status === 403
          ? "JSON output may be disabled on this SearXNG instance"
          : response.statusText || "request failed";
      throw new Error(`SearXNG search failed (${response.status}): ${detail}`);
    }

    const body = (await response.json()) as SearxngResponse;
    if (!Array.isArray(body.results)) {
      throw new Error("SearXNG returned an invalid JSON result set");
    }

    const results: SearchResult[] = [];
    for (const candidate of body.results as SearxngResult[]) {
      if (
        !candidate ||
        typeof candidate !== "object" ||
        typeof candidate.title !== "string" ||
        typeof candidate.url !== "string"
      ) {
        continue;
      }

      const title = candidate.title.trim();
      const resultUrl = candidate.url.trim();
      if (!title || !resultUrl) continue;

      results.push({
        title,
        url: resultUrl,
        ...(typeof candidate.content === "string" && candidate.content.trim()
          ? { snippet: candidate.content.trim() }
          : {}),
      });
      if (results.length >= limit) break;
    }

    return results;
  }
}
