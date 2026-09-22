import { describe, expect, it } from "vitest";
import type {
  SearchProvider,
  SearchResult,
} from "../src/contracts/providers.js";
import type { ProvidersConfig } from "../src/config/providers.js";
import {
  createSearchChain,
  createSearchProvider,
} from "../src/provider-registry.js";
import { FallbackSearchProvider } from "../src/providers/search/fallback.js";
import { SearxngSearchProvider } from "../src/providers/search/searxng.js";
import { SearchToolProvider } from "../src/search/tool-provider.js";

describe("SearXNG search provider", () => {
  it("normalizes JSON results, applies safe search, and enforces the requested limit", async () => {
    let requestedUrl = "";
    const provider = new SearxngSearchProvider("searx", {
      baseUrl: "https://search.example/",
      fetchImpl: (async (input, init) => {
        requestedUrl = String(input);
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return Response.json({
          results: [
            {
              title: " First ",
              url: "https://example.com/1",
              content: " snippet one ",
            },
            {
              title: "Second",
              url: "https://example.com/2",
              content: "",
            },
            {
              title: "Third",
              url: "https://example.com/3",
            },
          ],
        });
      }) as typeof fetch,
    });

    await expect(
      provider.search("nara project", { limit: 2 }),
    ).resolves.toEqual([
      {
        title: "First",
        url: "https://example.com/1",
        snippet: "snippet one",
      },
      {
        title: "Second",
        url: "https://example.com/2",
      },
    ]);

    const url = new URL(requestedUrl);
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("q")).toBe("nara project");
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.searchParams.get("safesearch")).toBe("1");
  });

  it("explains the common JSON-disabled SearXNG failure", async () => {
    const provider = new SearxngSearchProvider("searx", {
      baseUrl: "https://search.example",
      fetchImpl: (async () =>
        new Response("forbidden", {
          status: 403,
          statusText: "Forbidden",
        })) as typeof fetch,
    });

    await expect(provider.search("test")).rejects.toThrow(
      /JSON output may be disabled/,
    );
  });
});

describe("search fallback and tool routing", () => {
  it("falls back to the next search provider after a provider failure", async () => {
    const first: SearchProvider = {
      id: "first",
      async search() {
        throw new Error("offline");
      },
    };
    const second: SearchProvider = {
      id: "second",
      async search(): Promise<SearchResult[]> {
        return [{ title: "ok", url: "https://example.com" }];
      },
    };
    const fallback = new FallbackSearchProvider("search-fallback", [
      first,
      second,
    ]);

    await expect(fallback.search("query")).resolves.toEqual([
      { title: "ok", url: "https://example.com" },
    ]);
  });

  it("passes Action Runtime cancellation into the active search", async () => {
    let observedAbort = false;
    const search: SearchProvider = {
      id: "slow",
      search(_query, options) {
        return new Promise<SearchResult[]>((resolve) => {
          const signal = options?.signal;
          signal?.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              resolve([]);
            },
            { once: true },
          );
        });
      },
    };
    const tools = new SearchToolProvider(search);
    const controller = new AbortController();

    const pending = tools.callTool(
      {
        name: "web_search",
        arguments: { query: "latest nara", limit: 3 },
        callId: "search-1",
      },
      controller.signal,
    );
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      name: "web_search",
      callId: "search-1",
      ok: false,
      error: "Search cancelled",
    });
    expect(observedAbort).toBe(true);
  });

  it("constructs search routes only when configured", () => {
    const config = {
      voice: { primary: "voice", fallbacks: [] },
      brain: { primary: "brain", fallbacks: [] },
      search: { primary: "searx", fallbacks: [] },
      providers: {
        voice: {
          kind: "voice",
          adapter: "gemini-live",
          model: "test",
        },
        brain: {
          kind: "brain",
          adapter: "openai-compatible",
          base_url: "http://brain.local",
          model: "test",
        },
        searx: {
          kind: "search",
          adapter: "searxng",
          base_url: "http://search.local",
        },
      },
    } satisfies ProvidersConfig;

    expect(createSearchProvider("searx", config.providers.searx).id).toBe(
      "searx",
    );
    expect(createSearchChain(config)?.id).toBe("searx");

    const withoutSearch = {
      ...config,
      search: undefined,
    };
    expect(createSearchChain(withoutSearch as ProvidersConfig)).toBeUndefined();
  });
});
