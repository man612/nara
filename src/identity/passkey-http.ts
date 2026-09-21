import { timingSafeEqual } from "node:crypto";
import type {
  IncomingMessage,
  ServerResponse
} from "node:http";
import type { GatewayHttpHandler } from "../gateway.js";
import type { DeviceRegistry, DeviceRecord } from "../device/registry.js";
import type { PersonDirectory } from "./directory.js";
import type {
  HumanCredentialRegistry,
  HumanViewerIdentity
} from "./human-credentials.js";
import type { DeviceViewerGrantRegistry } from "./device-viewer-grants.js";
import type { PasskeyRegistry } from "./passkeys.js";

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
  maxBytes = 64 * 1024
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
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new Error("request body must be an object");
  }
  return parsed as Record<string, unknown>;
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

function eligibleProfile(
  directory: PersonDirectory,
  personId: string
) {
  const profile = directory.get(personId);
  return profile && profile.role !== "guest" ? profile : undefined;
}

function canViewerAccessDevice(
  viewer: HumanViewerIdentity,
  device: DeviceRecord,
  allowedDeviceId?: string
): boolean {
  if (device.state !== "active") return false;
  if (allowedDeviceId && device.deviceId === allowedDeviceId) {
    return true;
  }
  return Boolean(
    viewer.accountId &&
      device.accountId &&
      viewer.accountId === device.accountId
  );
}

export function createPasskeyHttpHandler(options: {
  passkeys: PasskeyRegistry;
  humanRegistry: HumanCredentialRegistry;
  viewerGrants: DeviceViewerGrantRegistry;
  directory: PersonDirectory;
  deviceRegistry: DeviceRegistry;
  adminToken: string;
  allowedDeviceId?: string;
}): GatewayHttpHandler {
  if (!options.adminToken.trim()) {
    throw new Error("Passkey admin token must not be empty");
  }

  const requireAdmin = (request: IncomingMessage): boolean => {
    const token = bearerToken(request);
    return Boolean(
      token && secureEqual(token, options.adminToken)
    );
  };

  const requireViewer = (
    request: IncomingMessage
  ): HumanViewerIdentity | undefined => {
    const token = bearerToken(request);
    return token
      ? options.humanRegistry.resolveSession(token)
      : undefined;
  };

  return async (request, response) => {
    const url = new URL(
      request.url ?? "/",
      "http://nara.local"
    );

    if (url.pathname === "/api/identity/passkeys/enrollments") {
      if (request.method !== "POST") {
        return json(response, 405, {
          ok: false,
          error: "method not allowed"
        });
      }
      if (!requireAdmin(request)) {
        return json(response, 401, {
          ok: false,
          error: "admin authorization required"
        });
      }
      try {
        const body = await readJson(request);
        if (
          typeof body.personId !== "string" ||
          !body.personId.trim() ||
          (body.accountId !== undefined &&
            (typeof body.accountId !== "string" ||
              !body.accountId.trim()))
        ) {
          return json(response, 400, {
            ok: false,
            error: "valid personId/accountId required"
          });
        }
        const profile = eligibleProfile(
          options.directory,
          body.personId
        );
        if (!profile) {
          return json(response, 404, {
            ok: false,
            error: "unknown eligible person"
          });
        }

        const ttlMs =
          typeof body.ttlMinutes === "number"
            ? body.ttlMinutes * 60_000
            : undefined;
        const enrollment = await options.passkeys.issueEnrollment({
          personId: profile.personId,
          ...(typeof body.accountId === "string"
            ? { accountId: body.accountId.trim() }
            : {}),
          ...(ttlMs !== undefined ? { ttlMs } : {})
        });
        return json(response, 201, {
          ok: true,
          ...enrollment,
          person: {
            personId: profile.personId,
            displayName: profile.displayName,
            role: profile.role
          }
        });
      } catch (error) {
        return json(response, 400, {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "invalid enrollment request"
        });
      }
    }

    if (url.pathname === "/api/identity/passkeys/register/options") {
      if (request.method !== "POST") {
        return json(response, 405, {
          ok: false,
          error: "method not allowed"
        });
      }
      try {
        const body = await readJson(request);
        if (
          typeof body.enrollmentToken !== "string" ||
          !body.enrollmentToken.trim()
        ) {
          return json(response, 400, {
            ok: false,
            error: "enrollmentToken is required"
          });
        }
        const enrollmentIdentity =
          options.passkeys.getEnrollmentIdentity(
            body.enrollmentToken
          );
        const profile = eligibleProfile(
          options.directory,
          enrollmentIdentity.personId
        );
        if (!profile) {
          return json(response, 404, {
            ok: false,
            error: "unknown eligible person"
          });
        }
        const result = options.passkeys.createRegistrationOptions({
          enrollmentToken: body.enrollmentToken,
          displayName: profile.displayName
        });
        return json(response, 200, {
          ok: true,
          ...result
        });
      } catch (error) {
        return json(response, 400, {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "registration options failed"
        });
      }
    }

    if (url.pathname === "/api/identity/passkeys/register/verify") {
      if (request.method !== "POST") {
        return json(response, 405, {
          ok: false,
          error: "method not allowed"
        });
      }
      try {
        const body = await readJson(request);
        if (
          typeof body.ceremonyId !== "string" ||
          typeof body.enrollmentToken !== "string" ||
          body.credential === undefined
        ) {
          return json(response, 400, {
            ok: false,
            error:
              "ceremonyId, enrollmentToken and credential are required"
          });
        }
        const passkey = await options.passkeys.verifyRegistration({
          ceremonyId: body.ceremonyId,
          enrollmentToken: body.enrollmentToken,
          credential: body.credential
        });
        const profile = eligibleProfile(
          options.directory,
          passkey.personId
        );
        if (!profile) {
          await options.passkeys.revoke(passkey.credentialId);
          return json(response, 403, {
            ok: false,
            error: "registered person is no longer eligible"
          });
        }
        return json(response, 201, {
          ok: true,
          passkey: {
            credentialId: passkey.credentialId,
            personId: profile.personId,
            displayName: profile.displayName,
            algorithm: passkey.algorithm,
            createdAt: passkey.createdAt
          }
        });
      } catch (error) {
        return json(response, 400, {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "passkey registration failed"
        });
      }
    }

    if (url.pathname === "/api/identity/passkeys/authenticate/options") {
      if (request.method !== "POST") {
        return json(response, 405, {
          ok: false,
          error: "method not allowed"
        });
      }
      const result = options.passkeys.createAuthenticationOptions();
      return json(response, 200, {
        ok: true,
        ...result
      });
    }

    if (url.pathname === "/api/identity/passkeys/authenticate/verify") {
      if (request.method !== "POST") {
        return json(response, 405, {
          ok: false,
          error: "method not allowed"
        });
      }
      try {
        const body = await readJson(request);
        if (
          typeof body.ceremonyId !== "string" ||
          body.credential === undefined
        ) {
          return json(response, 400, {
            ok: false,
            error: "ceremonyId and credential are required"
          });
        }
        const viewer = await options.passkeys.verifyAuthentication({
          ceremonyId: body.ceremonyId,
          credential: body.credential
        });
        const profile = eligibleProfile(
          options.directory,
          viewer.personId
        );
        if (!profile) {
          return json(response, 403, {
            ok: false,
            error: "passkey person is no longer eligible"
          });
        }
        const session =
          options.humanRegistry.mintSessionForViewer(viewer);
        return json(response, 200, {
          ok: true,
          sessionToken: session.token,
          expiresAt: session.expiresAt,
          viewer: {
            personId: profile.personId,
            displayName: profile.displayName,
            role: profile.role,
            ...(viewer.accountId
              ? { accountId: viewer.accountId }
              : {})
          }
        });
      } catch (error) {
        return json(response, 401, {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "passkey authentication failed"
        });
      }
    }

    if (url.pathname === "/api/identity/passkeys") {
      if (!requireAdmin(request)) {
        return json(response, 401, {
          ok: false,
          error: "admin authorization required"
        });
      }

      if (request.method === "GET") {
        const personId = url.searchParams.get("personId");
        if (!personId) {
          return json(response, 400, {
            ok: false,
            error: "personId required"
          });
        }
        return json(response, 200, {
          ok: true,
          passkeys: options.passkeys
            .listForPerson(personId)
            .map((record) => ({
              credentialId: record.credentialId,
              algorithm: record.algorithm,
              transports: record.transports ?? [],
              createdAt: record.createdAt,
              updatedAt: record.updatedAt,
              ...(record.lastUsedAt
                ? { lastUsedAt: record.lastUsedAt }
                : {})
            }))
        });
      }

      if (request.method === "DELETE") {
        const credentialId =
          url.searchParams.get("credentialId");
        if (!credentialId) {
          return json(response, 400, {
            ok: false,
            error: "credentialId required"
          });
        }
        try {
          await options.passkeys.revoke(credentialId);
          return json(response, 200, { ok: true });
        } catch {
          return json(response, 404, {
            ok: false,
            error: "unknown passkey"
          });
        }
      }

      return json(response, 405, {
        ok: false,
        error: "method not allowed"
      });
    }

    if (url.pathname === "/api/identity/devices") {
      if (request.method !== "GET") {
        return json(response, 405, {
          ok: false,
          error: "method not allowed"
        });
      }
      const viewer = requireViewer(request);
      if (!viewer) {
        return json(response, 401, {
          ok: false,
          error: "viewer session required"
        });
      }
      const devices = options.deviceRegistry
        .listDevices()
        .filter((device) =>
          canViewerAccessDevice(
            viewer,
            device,
            options.allowedDeviceId
          )
        )
        .map((device) => ({
          deviceId: device.deviceId,
          ...(device.clientId
            ? { clientId: device.clientId }
            : {}),
          state: device.state
        }));
      return json(response, 200, {
        ok: true,
        devices
      });
    }

    if (url.pathname === "/api/identity/device-viewer-grants") {
      const viewer = requireViewer(request);
      if (!viewer) {
        return json(response, 401, {
          ok: false,
          error: "viewer session required"
        });
      }

      const deviceId =
        request.method === "GET" ||
        request.method === "DELETE"
          ? url.searchParams.get("deviceId") ?? ""
          : "";

      if (request.method === "GET") {
        if (!deviceId) {
          return json(response, 400, {
            ok: false,
            error: "deviceId required"
          });
        }
        const device =
          options.deviceRegistry.getDevice(deviceId);
        if (
          !device ||
          !canViewerAccessDevice(
            viewer,
            device,
            options.allowedDeviceId
          )
        ) {
          return json(response, 403, {
            ok: false,
            error: "device is not available to this viewer"
          });
        }
        const grant = options.viewerGrants.inspect(deviceId);
        return json(response, 200, {
          ok: true,
          active:
            grant?.personId === viewer.personId &&
            grant?.accountId === viewer.accountId,
          ...(grant &&
          grant.personId === viewer.personId &&
          grant.accountId === viewer.accountId
            ? { grant }
            : {})
        });
      }

      if (request.method === "DELETE") {
        if (!deviceId) {
          return json(response, 400, {
            ok: false,
            error: "deviceId required"
          });
        }
        const current = options.viewerGrants.inspect(deviceId);
        if (
          current &&
          (current.personId !== viewer.personId ||
            current.accountId !== viewer.accountId)
        ) {
          return json(response, 403, {
            ok: false,
            error: "viewer cannot revoke another person's grant"
          });
        }
        options.viewerGrants.revoke(deviceId);
        return json(response, 200, { ok: true });
      }

      if (request.method === "POST") {
        try {
          const body = await readJson(request);
          if (
            typeof body.deviceId !== "string" ||
            !body.deviceId.trim()
          ) {
            return json(response, 400, {
              ok: false,
              error: "deviceId required"
            });
          }
          const device = options.deviceRegistry.getDevice(
            body.deviceId
          );
          if (
            !device ||
            !canViewerAccessDevice(
              viewer,
              device,
              options.allowedDeviceId
            )
          ) {
            return json(response, 403, {
              ok: false,
              error: "device is not available to this viewer"
            });
          }
          const ttlMs =
            typeof body.ttlMinutes === "number"
              ? body.ttlMinutes * 60_000
              : undefined;
          const grant = options.viewerGrants.grant(
            device.deviceId,
            viewer,
            ttlMs !== undefined ? { ttlMs } : {}
          );
          return json(response, 201, {
            ok: true,
            grant
          });
        } catch (error) {
          return json(response, 400, {
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : "viewer grant failed"
          });
        }
      }

      return json(response, 405, {
        ok: false,
        error: "method not allowed"
      });
    }

    return false;
  };
}
