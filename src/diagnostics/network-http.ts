import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
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

const MAX_BYTES = 512 * 1024;
const DEFAULT_BYTES = 128 * 1024;
const DOWNLOAD_CHUNK = Buffer.alloc(16 * 1024, 0x4e);

export type NetworkDiagnosticResult = {
  rttMs: number;
  downloadMbps?: number;
  uploadMbps?: number;
};

export function mbpsToMegabytesPerSecond(mbps: number): number {
  return mbps / 8;
}

export function describeNetworkId(result: NetworkDiagnosticResult): string {
  const parts: string[] = [];

  if (result.rttMs < 40) {
    parts.push("Ping sangat rendah, cocok untuk percakapan realtime.");
  } else if (result.rttMs < 90) {
    parts.push("Ping cukup bagus untuk percakapan realtime.");
  } else if (result.rttMs < 180) {
    parts.push("Ping mulai terasa, tapi masih bisa dipakai.");
  } else {
    parts.push("Ping tinggi dan kemungkinan terasa saat ngobrol.");
  }

  if (result.downloadMbps !== undefined) {
    parts.push(
      "Download sekitar " +
        result.downloadMbps.toFixed(1) +
        " Mbps, kira-kira " +
        mbpsToMegabytesPerSecond(result.downloadMbps).toFixed(1) +
        " MB per detik."
    );
  }
  if (result.uploadMbps !== undefined) {
    parts.push(
      "Upload sekitar " +
        result.uploadMbps.toFixed(1) +
        " Mbps."
    );
  }
  return parts.join(" ");
}

export function createNetworkDiagnosticsHttpHandler(options: {
  bearerToken: string;
}): GatewayHttpHandler {
  if (options.bearerToken.trim().length < 24) {
    throw new Error("Diagnostics bearer token must be at least 24 characters");
  }

  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://nara.local");
    if (!url.pathname.startsWith("/api/diagnostics/")) return false;

    const token = bearerToken(request);
    if (!token || !secureEqual(token, options.bearerToken)) {
      response.writeHead(401, {
        "content-type": "application/json",
        "cache-control": "no-store"
      });
      response.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return true;
    }

    if (url.pathname === "/api/diagnostics/ping") {
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store"
      });
      response.end(
        JSON.stringify({
          ok: true,
          serverTimeMs: Date.now()
        })
      );
      return true;
    }

    if (url.pathname === "/api/diagnostics/download") {
      if (request.method !== "GET") {
        response.writeHead(405).end();
        return true;
      }
      const requested = Number(
        url.searchParams.get("bytes") ?? DEFAULT_BYTES
      );
      const bytes = Math.min(
        MAX_BYTES,
        Math.max(
          1024,
          Number.isFinite(requested)
            ? Math.trunc(requested)
            : DEFAULT_BYTES
        )
      );
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(bytes),
        "cache-control": "no-store"
      });
      let remaining = bytes;
      while (remaining > 0) {
        const chunk = Math.min(remaining, DOWNLOAD_CHUNK.length);
        response.write(DOWNLOAD_CHUNK.subarray(0, chunk));
        remaining -= chunk;
      }
      response.end();
      return true;
    }

    if (url.pathname === "/api/diagnostics/upload") {
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return true;
      }

      let bytes = 0;
      for await (const chunk of request) {
        bytes += Buffer.isBuffer(chunk)
          ? chunk.length
          : Buffer.byteLength(chunk);
        if (bytes > MAX_BYTES) {
          response.writeHead(413, {
            "content-type": "application/json"
          });
          response.end(
            JSON.stringify({ ok: false, error: "payload too large" })
          );
          return true;
        }
      }

      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store"
      });
      response.end(JSON.stringify({ ok: true, bytes }));
      return true;
    }

    response.writeHead(404).end();
    return true;
  };
}
