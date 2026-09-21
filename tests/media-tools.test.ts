import { describe, expect, it } from "vitest";
import { MediaToolProvider } from "../src/media/tool-provider.js";
import { SpotifyWebApiProvider } from "../src/media/spotify.js";

describe("SpotifyWebApiProvider", () => {
  it("refreshes once, caches the token, and controls/searches playback without AI calls", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method });

      if (url.includes("accounts.spotify.com/api/token")) {
        return new Response(
          JSON.stringify({
            access_token: "access-1",
            token_type: "Bearer",
            expires_in: 3600
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      if (url.includes("/search?")) {
        return new Response(
          JSON.stringify({
            tracks: {
              items: [
                {
                  uri: "spotify:track:abc",
                  name: "Example Song",
                  artists: [{ name: "Example Artist" }]
                }
              ]
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const provider = new SpotifyWebApiProvider(
      {
        clientId: "id",
        clientSecret: "secret",
        refreshToken: "refresh"
      },
      { fetchImpl, now: () => 1_000 }
    );
    const signal = new AbortController().signal;

    await provider.control({ op: "volume", volume: 37 }, signal);
    const tracks = await provider.searchTracks("example", 5, signal);
    await provider.playTrack(tracks[0]!.uri, signal);

    expect(tracks).toEqual([
      {
        uri: "spotify:track:abc",
        title: "Example Song",
        artists: ["Example Artist"]
      }
    ]);
    expect(
      requests.filter((request) =>
        request.url.includes("accounts.spotify.com/api/token")
      )
    ).toHaveLength(1);
    expect(
      requests.some((request) =>
        request.url.includes("/me/player/volume?volume_percent=37")
      )
    ).toBe(true);
    expect(
      requests.some((request) => request.url.includes("/search?"))
    ).toBe(true);
  });
});

describe("MediaToolProvider", () => {
  it("uses one compact search_play operation and plays the first track", async () => {
    const played: string[] = [];
    const provider = new MediaToolProvider({
      id: "fake-media",
      async control() {},
      async searchTracks(query, limit) {
        expect(query).toBe("lagu favorit");
        expect(limit).toBe(5);
        return [
          {
            uri: "spotify:track:one",
            title: "Lagu Satu",
            artists: ["Artis"]
          }
        ];
      },
      async playTrack(uri) {
        played.push(uri);
      }
    });

    const tools = await provider.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("media_control");

    const result = await provider.callTool(
      {
        name: "media_control",
        arguments: { op: "search_play", query: "lagu favorit" },
        callId: "m1"
      },
      new AbortController().signal
    );

    expect(result.ok).toBe(true);
    expect(played).toEqual(["spotify:track:one"]);
    expect(result.value).toMatchObject({
      played: { title: "Lagu Satu", artists: ["Artis"] }
    });
  });
});
