import type {
  MediaCommand,
  MediaProvider,
  MediaTrack
} from "./contracts.js";

type SpotifyToken = {
  accessToken: string;
  expiresAt: number;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Spotify returned an invalid object");
  }
  return value as Record<string, unknown>;
}

export class SpotifyWebApiProvider implements MediaProvider {
  readonly id = "spotify";
  private token: SpotifyToken | undefined;

  constructor(
    private readonly credentials: {
      clientId: string;
      clientSecret: string;
      refreshToken: string;
    },
    private readonly options: {
      fetchImpl?: typeof fetch;
      now?: () => number;
    } = {}
  ) {}

  async control(command: MediaCommand, signal: AbortSignal): Promise<void> {
    switch (command.op) {
      case "play":
        await this.api("/me/player/play", { method: "PUT", signal });
        return;
      case "pause":
        await this.api("/me/player/pause", { method: "PUT", signal });
        return;
      case "next":
        await this.api("/me/player/next", { method: "POST", signal });
        return;
      case "previous":
        await this.api("/me/player/previous", { method: "POST", signal });
        return;
      case "volume": {
        if (
          !Number.isInteger(command.volume) ||
          command.volume < 0 ||
          command.volume > 100
        ) {
          throw new Error("volume must be an integer from 0 to 100");
        }
        await this.api(
          `/me/player/volume?volume_percent=${command.volume}`,
          { method: "PUT", signal }
        );
      }
    }
  }

  async searchTracks(
    query: string,
    limit: number,
    signal: AbortSignal
  ): Promise<MediaTrack[]> {
    const normalized = query.trim();
    if (!normalized || normalized.length > 300) {
      throw new Error("search query must be 1..300 characters");
    }
    const boundedLimit = Math.min(5, Math.max(1, Math.floor(limit)));
    const response = await this.api(
      `/search?q=${encodeURIComponent(normalized)}&type=track&limit=${boundedLimit}`,
      { method: "GET", signal }
    );
    const root = asRecord(await response.json());
    const tracks = asRecord(root.tracks);
    if (!Array.isArray(tracks.items)) {
      throw new Error("Spotify search response has no track items");
    }

    const result: MediaTrack[] = [];
    for (const itemValue of tracks.items) {
      try {
        const item = asRecord(itemValue);
        if (
          typeof item.uri !== "string" ||
          typeof item.name !== "string" ||
          !Array.isArray(item.artists)
        ) {
          continue;
        }
        const artists = item.artists
          .map((artist) => {
            try {
              const value = asRecord(artist);
              return typeof value.name === "string" ? value.name : undefined;
            } catch {
              return undefined;
            }
          })
          .filter((value): value is string => value !== undefined);
        result.push({
          uri: item.uri,
          title: item.name,
          artists
        });
      } catch {
        continue;
      }
    }
    return result;
  }

  async playTrack(uri: string, signal: AbortSignal): Promise<void> {
    if (!uri.startsWith("spotify:track:")) {
      throw new Error("Only Spotify track URIs may be played by this action");
    }
    await this.api("/me/player/play", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uris: [uri] }),
      signal
    });
  }

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  private async accessToken(signal: AbortSignal, force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt - 60_000 > this.now) {
      return this.token.accessToken;
    }

    const basic = Buffer.from(
      `${this.credentials.clientId}:${this.credentials.clientSecret}`
    ).toString("base64");
    const response = await this.fetchImpl(
      "https://accounts.spotify.com/api/token",
      {
        method: "POST",
        headers: {
          authorization: `Basic ${basic}`,
          "content-type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: this.credentials.refreshToken
        }),
        signal
      }
    );
    if (!response.ok) {
      throw new Error(`Spotify token refresh failed: HTTP ${response.status}`);
    }

    const value = asRecord(await response.json());
    if (
      typeof value.access_token !== "string" ||
      typeof value.expires_in !== "number"
    ) {
      throw new Error("Spotify token response is invalid");
    }
    this.token = {
      accessToken: value.access_token,
      expiresAt: this.now + value.expires_in * 1000
    };
    return this.token.accessToken;
  }

  private async api(
    path: string,
    init: RequestInit,
    retried = false
  ): Promise<Response> {
    const signal = init.signal instanceof AbortSignal
      ? init.signal
      : new AbortController().signal;
    const token = await this.accessToken(signal, retried);
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);

    const response = await this.fetchImpl(
      `https://api.spotify.com/v1${path}`,
      {
        ...init,
        headers
      }
    );
    if (response.status === 401 && !retried) {
      this.token = undefined;
      return this.api(path, init, true);
    }
    if (!response.ok) {
      throw new Error(`Spotify API failed: HTTP ${response.status}`);
    }
    return response;
  }
}
