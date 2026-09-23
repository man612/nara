import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeviceRegistry } from "../src/device/registry.js";
import { createGatewayServer } from "../src/gateway.js";
import { DeviceViewerGrantRegistry } from "../src/identity/device-viewer-grants.js";
import { PersonDirectory } from "../src/identity/directory.js";
import { HumanCredentialRegistry } from "../src/identity/human-credentials.js";
import { createPasskeyHttpHandler } from "../src/identity/passkey-http.js";
import { PasskeyRegistry } from "../src/identity/passkeys.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "nara-passkey-http-"));
  tempDirs.push(directory);

  const people = new PersonDirectory([
    {
      personId: "person:partner",
      displayName: "Partner",
      role: "primary",
      accountIds: ["account:partner"]
    },
    {
      personId: "person:creator",
      displayName: "Creator",
      role: "creator",
      accountIds: ["account:creator"]
    },
    {
      personId: "person:guest",
      displayName: "Guest",
      role: "guest"
    }
  ]);

  const devices = await DeviceRegistry.open({
    filePath: join(directory, "devices.json")
  });
  await devices.registerUnclaimedDevice({ deviceId: "device-1" });
  const claim = await devices.beginClaim("device-1");
  await devices.approveClaimFromAccount({
    claimId: claim.claimId,
    claimToken: claim.claimToken,
    accountId: "account:partner"
  });
  await devices.confirmPhysicalClaim({
    claimId: claim.claimId,
    deviceId: "device-1"
  });
  await devices.completeClaim({
    claimId: claim.claimId,
    deviceId: "device-1"
  });

  const humans = await HumanCredentialRegistry.open({
    filePath: join(directory, "humans.json")
  });
  const partnerCredential = await humans.issue({
    personId: "person:partner",
    accountId: "account:partner"
  });
  const creatorCredential = await humans.issue({
    personId: "person:creator",
    accountId: "account:creator"
  });
  const partnerSession = humans.mintSession(
    partnerCredential.credential
  );
  const creatorSession = humans.mintSession(
    creatorCredential.credential
  );

  const passkeys = await PasskeyRegistry.open({
    filePath: join(directory, "passkeys.json"),
    rpId: "nara.example",
    origins: ["https://nara.example"]
  });
  const grants = new DeviceViewerGrantRegistry();

  const gateway = createGatewayServer({
    httpHandlers: [
      createPasskeyHttpHandler({
        passkeys,
        humanRegistry: humans,
        viewerGrants: grants,
        directory: people,
        deviceRegistry: devices,
        adminToken: "admin-secret"
      })
    ]
  });
  await new Promise<void>((resolve) =>
    gateway.server.listen(0, "127.0.0.1", resolve)
  );
  const port = (gateway.server.address() as AddressInfo).port;

  return {
    gateway,
    port,
    passkeys,
    grants,
    partnerSession,
    creatorSession
  };
}

async function closeGateway(
  gateway: ReturnType<typeof createGatewayServer>
) {
  await new Promise<void>((resolve) =>
    gateway.wss.close(() => resolve())
  );
  await new Promise<void>((resolve) =>
    gateway.server.close(() => resolve())
  );
}

describe("passkey identity HTTP", () => {
  it("binds enrollment to the server-side person and issues no browser-chosen subject", async () => {
    const ctx = await setup();
    try {
      const enrollmentResponse = await fetch(
        `http://127.0.0.1:${ctx.port}/api/identity/passkeys/enrollments`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer admin-secret",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            personId: "person:partner",
            accountId: "account:partner"
          })
        }
      );
      const enrollment = (await enrollmentResponse.json()) as {
        enrollmentToken: string;
      };
      expect(enrollmentResponse.status).toBe(201);

      const optionsResponse = await fetch(
        `http://127.0.0.1:${ctx.port}/api/identity/passkeys/register/options`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            enrollmentToken: enrollment.enrollmentToken,
            personId: "person:creator"
          })
        }
      );
      const options = (await optionsResponse.json()) as {
        publicKey: {
          user: { name: string; displayName: string };
          authenticatorSelection: {
            residentKey: string;
            userVerification: string;
          };
        };
      };
      expect(optionsResponse.status).toBe(200);
      expect(options.publicKey.user).toMatchObject({
        name: "person:partner",
        displayName: "Partner"
      });
      expect(options.publicKey.authenticatorSelection).toMatchObject({
        residentKey: "required",
        userVerification: "required"
      });
    } finally {
      await closeGateway(ctx.gateway);
    }
  });

  it("lets an authenticated viewer create a backup-passkey enrollment only for itself", async () => {
    const ctx = await setup();
    try {
      const response = await fetch(
        `http://127.0.0.1:${ctx.port}/api/identity/passkeys/enrollments`,
        {
          method: "POST",
          headers: {
            authorization:
              "Bearer " + ctx.partnerSession.token,
            "content-type": "application/json"
          },
          body: JSON.stringify({})
        }
      );
      const body = (await response.json()) as {
        enrollmentToken?: string;
        person?: { personId?: string };
      };
      expect(response.status).toBe(201);
      expect(body.enrollmentToken).toBeTruthy();
      expect(body.person?.personId).toBe("person:partner");

      const forbidden = await fetch(
        `http://127.0.0.1:${ctx.port}/api/identity/passkeys/enrollments`,
        {
          method: "POST",
          headers: {
            authorization:
              "Bearer " + ctx.partnerSession.token,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            personId: "person:creator"
          })
        }
      );
      expect(forbidden.status).toBe(403);
    } finally {
      await closeGateway(ctx.gateway);
    }
  });

  it("grants physical private-memory viewer only to an authorized human session", async () => {
    const ctx = await setup();
    try {
      const devicesResponse = await fetch(
        `http://127.0.0.1:${ctx.port}/api/identity/devices`,
        {
          headers: {
            authorization:
              "Bearer " + ctx.partnerSession.token
          }
        }
      );
      await expect(devicesResponse.json()).resolves.toMatchObject({
        ok: true,
        devices: [{ deviceId: "device-1", state: "active" }]
      });

      const grantResponse = await fetch(
        `http://127.0.0.1:${ctx.port}/api/identity/device-viewer-grants`,
        {
          method: "POST",
          headers: {
            authorization:
              "Bearer " + ctx.partnerSession.token,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            deviceId: "device-1",
            ttlMinutes: 10
          })
        }
      );
      expect(grantResponse.status).toBe(201);
      expect(ctx.grants.resolve("device-1")).toEqual({
        personId: "person:partner",
        accountId: "account:partner"
      });

      const forbidden = await fetch(
        `http://127.0.0.1:${ctx.port}/api/identity/device-viewer-grants`,
        {
          method: "POST",
          headers: {
            authorization:
              "Bearer " + ctx.creatorSession.token,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            deviceId: "device-1"
          })
        }
      );
      expect(forbidden.status).toBe(403);
      expect(ctx.grants.resolve("device-1")).toEqual({
        personId: "person:partner",
        accountId: "account:partner"
      });
    } finally {
      await closeGateway(ctx.gateway);
    }
  });
});
