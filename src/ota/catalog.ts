export type OtaChannel = "stable" | "beta";

export type OtaRelease = {
  version: string;
  channel: OtaChannel;
  board: string;
  firmwareUrl: string;
  sha256?: string;
  size?: number;
};

export interface OtaCatalog {
  resolve(input: {
    board: string;
    channel: OtaChannel;
    signal?: AbortSignal;
  }): Promise<OtaRelease | undefined>;
}

type GitHubAsset = {
  name?: unknown;
  browser_download_url?: unknown;
};

type GitHubRelease = {
  draft?: unknown;
  prerelease?: unknown;
  assets?: unknown;
};

type CachedValue<T> = {
  value: T;
  expiresAt: number;
};

type ReleaseManifest = {
  schema: 1;
  channel: OtaChannel;
  board: string;
  firmware: {
    version: string;
    url: string;
    sha256?: string;
    size?: number;
  };
};

function isChannel(value: unknown): value is OtaChannel {
  return value === "stable" || value === "beta";
}

function parseManifest(value: unknown): ReleaseManifest | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const root = value as Record<string, unknown>;
  if (
    root.schema !== 1 ||
    !isChannel(root.channel) ||
    typeof root.board !== "string" ||
    root.firmware === null ||
    typeof root.firmware !== "object" ||
    Array.isArray(root.firmware)
  ) {
    return undefined;
  }
  const firmware = root.firmware as Record<string, unknown>;
  if (
    typeof firmware.version !== "string" ||
    firmware.version.length === 0 ||
    typeof firmware.url !== "string" ||
    !firmware.url.startsWith("https://")
  ) {
    return undefined;
  }
  if (
    firmware.sha256 !== undefined &&
    (typeof firmware.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/i.test(firmware.sha256))
  ) {
    return undefined;
  }
  if (
    firmware.size !== undefined &&
    (typeof firmware.size !== "number" ||
      !Number.isFinite(firmware.size) ||
      firmware.size <= 0)
  ) {
    return undefined;
  }

  return {
    schema: 1,
    channel: root.channel,
    board: root.board,
    firmware: {
      version: firmware.version,
      url: firmware.url,
      ...(typeof firmware.sha256 === "string"
        ? { sha256: firmware.sha256.toLowerCase() }
        : {}),
      ...(typeof firmware.size === "number" ? { size: firmware.size } : {})
    }
  };
}

export class GitHubReleaseOtaCatalog implements OtaCatalog {
  private releasesCache: CachedValue<GitHubRelease[]> | undefined;
  private readonly manifestCache = new Map<
    string,
    CachedValue<ReleaseManifest | undefined>
  >();

  constructor(
    private readonly repository: string,
    private readonly options: {
      githubToken?: string;
      cacheMs?: number;
      fetchImpl?: typeof fetch;
      now?: () => number;
    } = {}
  ) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
      throw new Error("GitHub OTA repository must use owner/name");
    }
  }

  async resolve(input: {
    board: string;
    channel: OtaChannel;
    signal?: AbortSignal;
  }): Promise<OtaRelease | undefined> {
    const releases = await this.loadReleases(input.signal);

    for (const release of releases) {
      if (release.draft === true) continue;
      if (input.channel === "stable" && release.prerelease === true) continue;
      if (!Array.isArray(release.assets)) continue;

      const manifestAssets = (release.assets as GitHubAsset[]).filter(
        (asset) =>
          typeof asset.name === "string" &&
          asset.name.endsWith(".manifest.json") &&
          typeof asset.browser_download_url === "string"
      );

      for (const asset of manifestAssets) {
        const manifest = await this.loadManifest(
          asset.browser_download_url as string,
          input.signal
        );
        if (!manifest || manifest.board !== input.board) continue;
        if (input.channel === "stable" && manifest.channel !== "stable") {
          continue;
        }

        return {
          version: manifest.firmware.version,
          channel: manifest.channel,
          board: manifest.board,
          firmwareUrl: manifest.firmware.url,
          ...(manifest.firmware.sha256
            ? { sha256: manifest.firmware.sha256 }
            : {}),
          ...(manifest.firmware.size ? { size: manifest.firmware.size } : {})
        };
      }
    }

    return undefined;
  }

  private get cacheMs(): number {
    return this.options.cacheMs ?? 10 * 60 * 1000;
  }

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  private get fetchImpl(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }

  private async loadReleases(signal?: AbortSignal): Promise<GitHubRelease[]> {
    if (this.releasesCache && this.releasesCache.expiresAt > this.now) {
      return this.releasesCache.value;
    }

    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "user-agent": "nara-ota-catalog"
    };
    if (this.options.githubToken) {
      headers.authorization = `Bearer ${this.options.githubToken}`;
    }

    const response = await this.fetchImpl(
      `https://api.github.com/repos/${this.repository}/releases?per_page=20`,
      {
        headers,
        ...(signal ? { signal } : {})
      }
    );
    if (!response.ok) {
      throw new Error(`GitHub releases request failed: ${response.status}`);
    }
    const value = (await response.json()) as unknown;
    if (!Array.isArray(value)) {
      throw new Error("GitHub releases response is not an array");
    }

    const releases = value as GitHubRelease[];
    this.releasesCache = {
      value: releases,
      expiresAt: this.now + this.cacheMs
    };
    return releases;
  }

  private async loadManifest(
    url: string,
    signal?: AbortSignal
  ): Promise<ReleaseManifest | undefined> {
    const cached = this.manifestCache.get(url);
    if (cached && cached.expiresAt > this.now) {
      return cached.value;
    }

    const response = await this.fetchImpl(
      url,
      signal ? { signal } : undefined
    );
    if (!response.ok) {
      return undefined;
    }
    const manifest = parseManifest((await response.json()) as unknown);
    this.manifestCache.set(url, {
      value: manifest,
      expiresAt: this.now + this.cacheMs
    });
    return manifest;
  }
}
