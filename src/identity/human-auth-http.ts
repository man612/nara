import type {
  IncomingMessage,
  ServerResponse
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { PersonDirectory } from "./directory.js";
import {
  HumanCredentialRegistry,
  type HumanViewerIdentity
} from "./human-credentials.js";
import type { GatewayHttpHandler } from "../gateway.js";

function bearerToken(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) return undefined;
  const token = value.slice(7).trim();
  return token || undefined;
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(
  request: IncomingMessage,
  maxBytes = 16 * 1024
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new Error("request body too large");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function json(
  response: ServerResponse,
  status: number,
  value: unknown
): true {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(value));
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createHumanAuthHttpHandler(options: {
  registry: HumanCredentialRegistry;
  directory: PersonDirectory;
  adminToken: string;
}): GatewayHttpHandler {
  if (!options.adminToken.trim()) {
    throw new Error("Human auth admin token must not be empty");
  }

  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://nara.local");

    if (url.pathname === "/api/identity/session") {
      if (request.method !== "POST") {
        return json(response, 405, { ok: false, error: "method not allowed" });
      }
      const credential = bearerToken(request);
      if (!credential) {
        return json(response, 401, { ok: false, error: "credential required" });
      }
      try {
        const session = options.registry.mintSession(credential);
        const profile = options.directory.get(session.viewer.personId);
        if (!profile || profile.role === "guest") {
          return json(response, 403, {
            ok: false,
            error: "credential is not bound to an eligible person"
          });
        }
        return json(response, 200, {
          ok: true,
          sessionToken: session.token,
          expiresAt: session.expiresAt,
          viewer: {
            personId: profile.personId,
            displayName: profile.displayName,
            role: profile.role
          }
        });
      } catch {
        return json(response, 401, {
          ok: false,
          error: "invalid or revoked credential"
        });
      }
    }

    if (url.pathname === "/api/identity/credentials") {
      const admin = bearerToken(request);
      if (!admin || !secureEqual(admin, options.adminToken)) {
        return json(response, 401, { ok: false, error: "admin authorization required" });
      }

      if (request.method === "POST") {
        try {
          const body = await readJson(request);
          if (
            !isRecord(body) ||
            typeof body.personId !== "string" ||
            body.personId.trim().length === 0 ||
            (body.accountId !== undefined &&
              (typeof body.accountId !== "string" ||
                body.accountId.trim().length === 0))
          ) {
            return json(response, 400, { ok: false, error: "invalid person/account" });
          }

          const profile = options.directory.get(body.personId);
          if (!profile || profile.role === "guest") {
            return json(response, 404, { ok: false, error: "unknown eligible person" });
          }

          const issued = await options.registry.issue({
            personId: profile.personId,
            ...(typeof body.accountId === "string"
              ? { accountId: body.accountId }
              : {})
          });
          return json(response, 201, {
            ok: true,
            ...issued,
            displayName: profile.displayName
          });
        } catch (error) {
          return json(response, 400, {
            ok: false,
            error: error instanceof Error ? error.message : "invalid request"
          });
        }
      }

      if (request.method === "DELETE") {
        const credentialId = url.searchParams.get("credentialId");
        if (!credentialId) {
          return json(response, 400, { ok: false, error: "credentialId required" });
        }
        try {
          await options.registry.revoke(credentialId);
          return json(response, 200, { ok: true });
        } catch {
          return json(response, 404, { ok: false, error: "unknown credential" });
        }
      }

      return json(response, 405, { ok: false, error: "method not allowed" });
    }

    return false;
  };
}

export function resolveHumanViewerSession(
  registry: HumanCredentialRegistry,
  sessionToken: string | undefined
): HumanViewerIdentity | undefined {
  return sessionToken ? registry.resolveSession(sessionToken) : undefined;
}
