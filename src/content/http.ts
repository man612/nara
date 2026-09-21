import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayHttpHandler } from "../gateway.js";
import {
  PersonalContentService,
  type PersonalContentDraft
} from "./personal-content.js";

const API_PREFIX = "/api/personal-content";
const MAX_BODY_BYTES = 64 * 1024;

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
): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(value));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error("request body too large");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    throw new Error("request body is required");
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function isDraft(value: unknown): value is PersonalContentDraft {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const draft = value as Record<string, unknown>;
  return typeof draft.kind === "string" && typeof draft.text === "string";
}

export function createPersonalContentHttpHandler(options: {
  service: PersonalContentService;
  bearerToken: string;
}): GatewayHttpHandler {
  if (options.bearerToken.trim().length < 24) {
    throw new Error("Personal content bearer token must be at least 24 characters");
  }

  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://nara.local");
    if (!url.pathname.startsWith(API_PREFIX)) {
      return false;
    }

    if (!tokenMatches(options.bearerToken, req.headers.authorization)) {
      json(res, 401, { ok: false, error: "unauthorized" });
      return true;
    }

    try {
      if (req.method === "GET" && url.pathname === `${API_PREFIX}/facts`) {
        const facts = await options.service.list();
        json(res, 200, {
          ok: true,
          facts: facts.map((fact) => ({
            id: fact.id,
            kind: fact.kind,
            text: fact.text,
            tags: fact.tags ?? [],
            visibility: fact.sensitivity === "public" ? "public" : "shared",
            shareWith: fact.shareWith ?? [],
            createdAt: fact.createdAt,
            updatedAt: fact.updatedAt,
            ...(fact.expiresAt ? { expiresAt: fact.expiresAt } : {})
          }))
        });
        return true;
      }

      if (req.method === "POST" && url.pathname === `${API_PREFIX}/facts`) {
        const body = await readJson(req);
        if (!isDraft(body)) {
          json(res, 400, { ok: false, error: "invalid content draft" });
          return true;
        }
        const fact = await options.service.upsert(body);
        json(res, 200, {
          ok: true,
          fact: {
            id: fact.id,
            kind: fact.kind,
            text: fact.text,
            sensitivity: fact.sensitivity,
            shareWith: fact.shareWith ?? [],
            updatedAt: fact.updatedAt
          }
        });
        return true;
      }

      if (
        req.method === "DELETE" &&
        url.pathname.startsWith(`${API_PREFIX}/facts/`)
      ) {
        const id = decodeURIComponent(
          url.pathname.slice(`${API_PREFIX}/facts/`.length)
        );
        const removed = await options.service.remove(id);
        json(res, removed ? 200 : 404, { ok: removed });
        return true;
      }

      json(res, 404, { ok: false, error: "not found" });
      return true;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "personal content request failed";
      json(res, 400, { ok: false, error: message });
      return true;
    }
  };
}
