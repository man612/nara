import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayHttpHandler } from "../gateway.js";
import type { DeviceRegistry } from "./registry.js";
import type { DeviceViewerGrantRegistry } from "../identity/device-viewer-grants.js";

function bearerToken(
  request: IncomingMessage
): string | undefined {
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

function publicDevice(record: ReturnType<DeviceRegistry["getDevice"]>) {
  if (!record) return undefined;
  const {
    credentialHash: _credentialHash,
    ...safe
  } = record;
  return safe;
}

export function createDeviceAdminHttpHandler(options: {
  registry: DeviceRegistry;
  viewerGrants: DeviceViewerGrantRegistry;
  adminToken: string;
}): GatewayHttpHandler {
  if (!options.adminToken.trim()) {
    throw new Error("Device admin token must not be empty");
  }

  return async (request, response) => {
    const url = new URL(
      request.url ?? "/",
      "http://nara.local"
    );

    if (
      url.pathname !== "/api/device-admin/devices" &&
      !url.pathname.startsWith(
        "/api/device-admin/devices/"
      )
    ) {
      return false;
    }

    const token = bearerToken(request);
    if (
      !token ||
      !secureEqual(token, options.adminToken)
    ) {
      return json(response, 401, {
        ok: false,
        error: "device admin authorization required"
      });
    }

    if (
      url.pathname === "/api/device-admin/devices" &&
      request.method === "GET"
    ) {
      return json(response, 200, {
        ok: true,
        devices: options.registry
          .listDevices()
          .map((record) => publicDevice(record))
      });
    }

    const match =
      /^\/api\/device-admin\/devices\/([^/]+)\/(release|revoke)$/.exec(
        url.pathname
      );
    if (!match) {
      return json(response, 404, {
        ok: false,
        error: "unknown device admin operation"
      });
    }
    if (request.method !== "POST") {
      return json(response, 405, {
        ok: false,
        error: "method not allowed"
      });
    }

    let deviceId: string;
    try {
      deviceId = decodeURIComponent(match[1] ?? "").trim();
    } catch {
      return json(response, 400, {
        ok: false,
        error: "invalid device id"
      });
    }
    if (!deviceId) {
      return json(response, 400, {
        ok: false,
        error: "device id required"
      });
    }

    try {
      if (match[2] === "release") {
        await options.registry.releaseDeviceForTransfer(
          deviceId
        );
      } else {
        await options.registry.revokeDevice(deviceId);
      }

      // Viewer privilege is session-like state and must never survive
      // ownership release or permanent device revocation.
      options.viewerGrants.revoke(deviceId);

      return json(response, 200, {
        ok: true,
        device: publicDevice(
          options.registry.getDevice(deviceId)
        )
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "device lifecycle operation failed";
      const status = message.includes("Unknown device")
        ? 404
        : 409;
      return json(response, status, {
        ok: false,
        error: message
      });
    }
  };
}
