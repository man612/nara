import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayHttpHandler } from "../gateway.js";
import type { OtaCatalog, OtaChannel } from "./catalog.js";
import { DeviceUpdateChannels } from "./channels.js";

const CHECK_PATH = "/api/ota/check";
const DEVICE_PREFIX = "/api/ota/devices/";

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(value));
}

function header(
  value: string | string[] | undefined
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseUserAgent(
  userAgent: string | undefined
): { board: string; version: string } | undefined {
  if (!userAgent) return undefined;
  const split = userAgent.lastIndexOf("/");
  if (split <= 0 || split === userAgent.length - 1) return undefined;
  return {
    board: userAgent.slice(0, split),
    version: userAgent.slice(split + 1)
  };
}

type ParsedVersion = {
  core: number[];
  prerelease?: Array<number | string>;
};

function parseVersion(value: string): ParsedVersion | undefined {
  const normalized = value.trim().replace(/^v/, "");
  const [coreText, prereleaseText] = normalized.split("-", 2);
  const coreParts = coreText?.split(".");
  if (!coreParts || coreParts.length === 0) return undefined;
  const core: number[] = [];
  for (const part of coreParts) {
    if (!/^\d+$/.test(part)) return undefined;
    core.push(Number(part));
  }

  const prerelease = prereleaseText
    ? prereleaseText.split(".").map((part) =>
        /^\d+$/.test(part) ? Number(part) : part
      )
    : undefined;

  return {
    core,
    ...(prerelease ? { prerelease } : {})
  };
}

export function compareVersions(left: string, right: string): number | undefined {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return undefined;

  const length = Math.max(a.core.length, b.core.length);
  for (let index = 0; index < length; index += 1) {
    const av = a.core[index] ?? 0;
    const bv = b.core[index] ?? 0;
    if (av !== bv) return av < bv ? -1 : 1;
  }

  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;

  const preLength = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < preLength; index += 1) {
    const av = a.prerelease[index];
    const bv = b.prerelease[index];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    if (av === bv) continue;
    if (typeof av === "number" && typeof bv === "number") {
      return av < bv ? -1 : 1;
    }
    if (typeof av === "number") return -1;
    if (typeof bv === "number") return 1;
    return av < bv ? -1 : 1;
  }
  return 0;
}

function tokenMatches(expected: string, authorization: string | undefined): boolean {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const expectedHash = createHash("sha256").update(expected).digest();
  const actualHash = createHash("sha256").update(match[1]!).digest();
  return timingSafeEqual(expectedHash, actualHash);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 16 * 1024) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function isChannel(value: unknown): value is OtaChannel {
  return value === "stable" || value === "beta";
}

export function createOtaHttpHandler(options: {
  catalog: OtaCatalog;
  channels: DeviceUpdateChannels;
  adminToken?: string;
  now?: () => number;
}): GatewayHttpHandler {
  if (options.adminToken && options.adminToken.trim().length < 24) {
    throw new Error("OTA admin token must be at least 24 characters");
  }

  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://nara.local");

    if (url.pathname === CHECK_PATH && (req.method === "POST" || req.method === "GET")) {
      const identity = parseUserAgent(header(req.headers["user-agent"]));
      if (!identity) {
        json(res, 400, { error: "board/version user-agent required" });
        return true;
      }

      const deviceId = header(req.headers["device-id"]);
      const channel = options.channels.get(deviceId);
      const release = await options.catalog.resolve({
        board: identity.board,
        channel
      });

      const response: Record<string, unknown> = {
        server_time: {
          timestamp: (options.now ?? Date.now)(),
          timezone_offset: 0
        }
      };

      if (release) {
        const comparison = compareVersions(identity.version, release.version);
        const differs = identity.version !== release.version;
        const shouldUpdate =
          comparison === undefined ? differs : comparison < 0;

        if (shouldUpdate) {
          const requiresForce =
            differs &&
            (identity.version.includes("-") || release.version.includes("-"));
          response.firmware = {
            version: release.version,
            url: release.firmwareUrl,
            ...(release.sha256 ? { sha256: release.sha256 } : {}),
            ...(release.size ? { size: release.size } : {}),
            ...(requiresForce ? { force: 1 } : {})
          };
        }
      }

      json(res, 200, response);
      return true;
    }

    if (!url.pathname.startsWith(DEVICE_PREFIX)) {
      return false;
    }

    if (
      !options.adminToken ||
      !tokenMatches(options.adminToken, req.headers.authorization)
    ) {
      json(res, 401, { ok: false, error: "unauthorized" });
      return true;
    }

    const suffix = url.pathname.slice(DEVICE_PREFIX.length);
    const marker = "/channel";
    if (!suffix.endsWith(marker)) {
      json(res, 404, { ok: false, error: "not found" });
      return true;
    }
    const deviceId = decodeURIComponent(suffix.slice(0, -marker.length));
    if (!deviceId) {
      json(res, 400, { ok: false, error: "device ID required" });
      return true;
    }

    if (req.method === "GET") {
      json(res, 200, {
        ok: true,
        deviceId,
        channel: options.channels.get(deviceId)
      });
      return true;
    }

    if (req.method === "PUT") {
      const body = await readJson(req);
      const channel =
        body && typeof body === "object" && !Array.isArray(body)
          ? (body as { channel?: unknown }).channel
          : undefined;
      if (!isChannel(channel)) {
        json(res, 400, { ok: false, error: "channel must be stable or beta" });
        return true;
      }
      await options.channels.set(deviceId, channel);
      json(res, 200, { ok: true, deviceId, channel });
      return true;
    }

    json(res, 405, { ok: false, error: "method not allowed" });
    return true;
  };
}
