import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayHttpHandler } from "../gateway.js";
import {
  compileOfflineCapsule,
  type OfflineCapsule
} from "./capsule.js";
import type { FilePersonalMemoryStore } from "../memory/personal.js";

function tokenMatches(expected: string, authorization: string | undefined): boolean {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const expectedHash = createHash("sha256").update(expected).digest();
  const actualHash = createHash("sha256").update(match[1]!).digest();
  return timingSafeEqual(expectedHash, actualHash);
}

function json(
  res: ServerResponse,
  status: number,
  value: unknown
): true {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-disposition": 'attachment; filename="offline_capsule.json"'
  });
  res.end(JSON.stringify(value));
  return true;
}

export function createOfflineCapsuleHttpHandler(options: {
  store: FilePersonalMemoryStore;
  bearerToken: string;
  recipientPersonId: string;
  subjectPersonId: string;
  now?: () => Date;
}): GatewayHttpHandler {
  if (options.bearerToken.trim().length < 24) {
    throw new Error("Offline capsule bearer token must be at least 24 characters");
  }

  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://nara.local");
    if (url.pathname !== "/api/offline-capsule") {
      return false;
    }

    if (req.method !== "GET") {
      return json(res, 405, { ok: false, error: "method not allowed" });
    }

    if (!tokenMatches(options.bearerToken, req.headers.authorization)) {
      return json(res, 401, { ok: false, error: "unauthorized" });
    }

    try {
      const capsule: OfflineCapsule = await compileOfflineCapsule({
        store: options.store,
        recipientPersonId: options.recipientPersonId,
        subjectPersonId: options.subjectPersonId,
        ...(options.now ? { now: options.now() } : {})
      });
      return json(res, 200, capsule);
    } catch (error) {
      return json(res, 400, {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "offline capsule compilation failed"
      });
    }
  };
}
