import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DeviceRegistry } from "../src/device/registry.js";
import {
  createGatewayServer,
  isGatewayDeviceAuthorized
} from "../src/gateway.js";
import {
  GitHubReleaseOtaCatalog,
  type OtaCatalog,
  type OtaChannel
} from "../src/ota/catalog.js";
import { DeviceUpdateChannels } from "../src/ota/channels.js";
import { compareVersions, createOtaHttpHandler } from "../src/ota/http.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("GitHub release OTA catalog", () => {
  it("keeps stable devices off prereleases while beta devices may receive them", async () => {
    const releases = [
      {
        draft: false,
        prerelease: true,
        assets: [
          {
            name: "nara-waveshare-1.85b.manifest.json",
            browser_download_url: "https://downloads.invalid/beta.json"
          }
        ]
      },
      {
        draft: false,
        prerelease: false,
        assets: [
          {
            name: "nara-waveshare-1.85b.manifest.json",
            browser_download_url: "https://downloads.invalid/stable.json"
          }
        ]
      }
    ];

    const manifests: Record<string, unknown> = {
      "https://downloads.invalid/beta.json": {
        schema: 1,
        channel: "beta",
        board: "esp32-s3-touch-lcd-1.85b",
        firmware: {
          version: "0.3.0-beta.1",
          url: "https://downloads.invalid/nara-beta.ota.bin",
          sha256: "a".repeat(64),
          size: 1234
        }
      },
      "https://downloads.invalid/stable.json": {
        schema: 1,
        channel: "stable",
        board: "esp32-s3-touch-lcd-1.85b",
        firmware: {
          version: "0.2.0",
          url: "https://downloads.invalid/nara-stable.ota.bin",
          sha256: "b".repeat(64),
          size: 1200
        }
      }
    };

    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("api.github.com")) {
        return new Response(JSON.stringify(releases), { status: 200 });
      }
      return new Response(JSON.stringify(manifests[url]), { status: 200 });
    }) as typeof fetch;

    const catalog = new GitHubReleaseOtaCatalog("man612/nara-firmware", {
      fetchImpl
    });

    await expect(
      catalog.resolve({
        board: "esp32-s3-touch-lcd-1.85b",
        channel: "stable"
      })
    ).resolves.toMatchObject({
      version: "0.2.0",
      channel: "stable"
    });

    await expect(
      catalog.resolve({
        board: "esp32-s3-touch-lcd-1.85b",
        channel: "beta"
      })
    ).resolves.toMatchObject({
      version: "0.3.0-beta.1",
      channel: "beta"
    });
  });
});

describe("OTA version comparison", () => {
  it("orders stable and prerelease versions conservatively", () => {
    expect(compareVersions("0.1.0", "0.2.0")).toBe(-1);
    expect(compareVersions("0.2.0-beta.1", "0.2.0")).toBe(-1);
    expect(compareVersions("0.2.0-beta.2", "0.2.0-beta.1")).toBe(1);
    expect(compareVersions("0.2.0", "0.2.0")).toBe(0);
  });
});

describe("OTA HTTP edge", () => {
  it("serves firmware-compatible checks and persists a beta channel without AI calls", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nara-ota-"));
    directories.push(directory);
    const channels = await DeviceUpdateChannels.open({
      filePath: join(directory, "channels.json")
    });
    const seenChannels: OtaChannel[] = [];
    const catalog: OtaCatalog = {
      async resolve(input) {
        seenChannels.push(input.channel);
        return input.channel === "beta"
          ? {
              version: "0.3.0-beta.1",
              channel: "beta",
              board: input.board,
              firmwareUrl: "https://downloads.invalid/beta.bin",
              sha256: "c".repeat(64)
            }
          : {
              version: "0.2.0",
              channel: "stable",
              board: input.board,
              firmwareUrl: "https://downloads.invalid/stable.bin",
              sha256: "d".repeat(64)
            };
      }
    };

    const adminToken = "0123456789abcdefghijklmnopqrstuvwxyz";
    const { server } = createGatewayServer({
      httpHandlers: [
        createOtaHttpHandler({
          catalog,
          channels,
          adminToken,
          now: () => Date.parse("2026-09-21T12:00:00.000Z")
        })
      ]
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const stable = await fetch(`${baseUrl}/api/ota/check`, {
        method: "POST",
        headers: {
          "device-id": "device-rizma",
          "user-agent": "esp32-s3-touch-lcd-1.85b/0.1.0"
        }
      });
      expect(stable.status).toBe(200);
      await expect(stable.json()).resolves.toMatchObject({
        firmware: {
          version: "0.2.0",
          url: "https://downloads.invalid/stable.bin"
        }
      });

      const setBeta = await fetch(
        `${baseUrl}/api/ota/devices/device-rizma/channel`,
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${adminToken}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({ channel: "beta" })
        }
      );
      expect(setBeta.status).toBe(200);

      const beta = await fetch(`${baseUrl}/api/ota/check`, {
        method: "POST",
        headers: {
          "device-id": "device-rizma",
          "user-agent": "esp32-s3-touch-lcd-1.85b/0.2.0"
        }
      });
      const betaBody = (await beta.json()) as {
        firmware: { version: string; force?: number };
      };
      expect(betaBody.firmware).toMatchObject({
        version: "0.3.0-beta.1",
        force: 1
      });
      expect(seenChannels).toEqual(["stable", "beta"]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it("requires an active device's credential while preserving bootstrap policy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nara-ota-auth-"));
    directories.push(directory);
    const registry = await DeviceRegistry.open({
      filePath: join(directory, "devices.json")
    });
    await registry.registerUnclaimedDevice({ deviceId: "device-rizma" });
    const claim = await registry.beginClaim("device-rizma");
    await registry.approveClaimFromAccount({
      claimId: claim.claimId,
      claimToken: claim.claimToken,
      accountId: "account:rizma"
    });
    await registry.confirmPhysicalClaim({
      claimId: claim.claimId,
      deviceId: "device-rizma"
    });
    const credential = await registry.completeClaim({
      claimId: claim.claimId,
      deviceId: "device-rizma"
    });

    const channels = await DeviceUpdateChannels.open();
    const catalog: OtaCatalog = {
      async resolve(input) {
        return {
          version: "0.2.0",
          channel: "stable",
          board: input.board,
          firmwareUrl: "https://downloads.invalid/stable.bin"
        };
      }
    };

    const { server } = createGatewayServer({
      httpHandlers: [
        createOtaHttpHandler({
          catalog,
          channels,
          authorizeDevice: (request) =>
            isGatewayDeviceAuthorized(request, {
              deviceRegistry: registry,
              deviceToken: "bootstrap-token"
            })
        })
      ]
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/api/ota/check`;

    try {
      const headers = {
        "device-id": "device-rizma",
        "user-agent": "esp32-s3-touch-lcd-1.85b/0.1.0"
      };

      const missing = await fetch(url, { headers });
      expect(missing.status).toBe(401);

      const fleetToken = await fetch(url, {
        headers: {
          ...headers,
          authorization: "Bearer bootstrap-token"
        }
      });
      expect(fleetToken.status).toBe(401);

      const authenticated = await fetch(url, {
        headers: {
          ...headers,
          authorization: `Bearer ${credential.credential}`
        }
      });
      expect(authenticated.status).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it("does not offer the same installed version again", async () => {
    const channels = await DeviceUpdateChannels.open();
    const catalog: OtaCatalog = {
      async resolve(input) {
        return {
          version: "0.2.0",
          channel: "stable",
          board: input.board,
          firmwareUrl: "https://downloads.invalid/stable.bin"
        };
      }
    };
    const { server } = createGatewayServer({
      httpHandlers: [createOtaHttpHandler({ catalog, channels })]
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;

    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/ota/check`,
        {
          headers: {
            "user-agent": "esp32-s3-touch-lcd-1.85b/0.2.0"
          }
        }
      );
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.firmware).toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});
