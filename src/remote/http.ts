import type { IncomingMessage } from "node:http";
import type { GatewayHttpHandler } from "../gateway.js";
import type { RemoteInbox } from "./inbox.js";

function headerString(
  value: string | string[] | undefined
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function readJsonBody(
  request: IncomingMessage,
  maxBytes = 4096
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new Error("request body too large");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("request body must be an object");
  }
  return parsed as Record<string, unknown>;
}

export function createRemoteInboxHttpHandler(options: {
  inbox: RemoteInbox;
  authorize: (request: IncomingMessage) => boolean;
}): GatewayHttpHandler {
  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://nara.local");
    if (!url.pathname.startsWith("/api/device-inbox/")) {
      return false;
    }

    if (!options.authorize(request)) {
      response.writeHead(401, {
        "content-type": "application/json",
        "cache-control": "no-store"
      });
      response.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return true;
    }

    const deviceId = headerString(request.headers["device-id"])?.trim();
    if (!deviceId) {
      response.writeHead(400, {
        "content-type": "application/json",
        "cache-control": "no-store"
      });
      response.end(
        JSON.stringify({ ok: false, error: "Device-Id header is required" })
      );
      return true;
    }

    if (
      request.method === "GET" &&
      url.pathname === "/api/device-inbox/poll"
    ) {
      const item = await options.inbox.poll(deviceId);
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store"
      });
      response.end(JSON.stringify({ ok: true, item }));
      return true;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/device-inbox/ack"
    ) {
      try {
        const body = await readJsonBody(request);
        const id = body.id;
        if (typeof id !== "string" || !id.trim()) {
          response.writeHead(400, {
            "content-type": "application/json",
            "cache-control": "no-store"
          });
          response.end(
            JSON.stringify({ ok: false, error: "id is required" })
          );
          return true;
        }

        const acknowledged = await options.inbox.ack(deviceId, id);
        response.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store"
        });
        response.end(
          JSON.stringify({ ok: true, acknowledged })
        );
      } catch (error) {
        response.writeHead(400, {
          "content-type": "application/json",
          "cache-control": "no-store"
        });
        response.end(
          JSON.stringify({
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : "invalid request"
          })
        );
      }
      return true;
    }

    response.writeHead(404, {
      "content-type": "application/json",
      "cache-control": "no-store"
    });
    response.end(JSON.stringify({ ok: false, error: "not found" }));
    return true;
  };
}
