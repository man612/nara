import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { DeviceRegistry } from "../src/device/registry.js";
import { createDeviceAdminHttpHandler } from "../src/device/admin-http.js";
import { DeviceViewerGrantRegistry } from "../src/identity/device-viewer-grants.js";
import { createGatewayServer } from "../src/gateway.js";

async function claimedDevice(
  registry: DeviceRegistry,
  deviceId: string,
  accountId: string
) {
  await registry.registerUnclaimedDevice({ deviceId });
  const claim = await registry.beginClaim(deviceId);
  await registry.approveClaimFromAccount({
    claimId: claim.claimId,
    claimToken: claim.claimToken,
    accountId
  });
  await registry.confirmPhysicalClaim({
    claimId: claim.claimId,
    deviceId
  });
  return registry.completeClaim({
    claimId: claim.claimId,
    deviceId
  });
}

describe("device admin lifecycle HTTP edge", () => {
  it("releases a device for transfer, kills old access, and revokes viewer privilege", async () => {
    const registry = await DeviceRegistry.open();
    const viewerGrants =
      new DeviceViewerGrantRegistry();
    const issued = await claimedDevice(
      registry,
      "device-transfer",
      "account:old"
    );
    viewerGrants.grant(
      "device-transfer",
      {
        personId: "person:old",
        accountId: "account:old"
      }
    );

    const gateway = createGatewayServer({
      httpHandlers: [
        createDeviceAdminHttpHandler({
          registry,
          viewerGrants,
          adminToken: "device-admin-secret"
        })
      ]
    });
    await new Promise<void>((resolve) =>
      gateway.server.listen(0, "127.0.0.1", resolve)
    );
    const port =
      (gateway.server.address() as AddressInfo).port;

    try {
      const unauthorized = await fetch(
        `http://127.0.0.1:${port}/api/device-admin/devices/device-transfer/release`,
        { method: "POST" }
      );
      expect(unauthorized.status).toBe(401);

      const response = await fetch(
        `http://127.0.0.1:${port}/api/device-admin/devices/device-transfer/release`,
        {
          method: "POST",
          headers: {
            authorization:
              "Bearer device-admin-secret"
          }
        }
      );
      expect(response.status).toBe(200);

      expect(
        registry.verifyDeviceCredential(
          "device-transfer",
          issued.credential
        )
      ).toBe(false);
      expect(
        viewerGrants.resolve("device-transfer")
      ).toBeUndefined();
      expect(
        registry.getDevice("device-transfer")
      ).toMatchObject({
        state: "unclaimed",
        credentialGeneration: 2
      });
      expect(
        registry.getDevice("device-transfer")
      ).not.toHaveProperty("accountId");
      expect(
        registry.getDevice("device-transfer")
      ).not.toHaveProperty("role");

      const newClaim =
        await registry.beginClaim("device-transfer");
      await registry.approveClaimFromAccount({
        claimId: newClaim.claimId,
        claimToken: newClaim.claimToken,
        accountId: "account:new"
      });
      await expect(
        registry.completeClaim({
          claimId: newClaim.claimId,
          deviceId: "device-transfer"
        })
      ).rejects.toThrow(/Physical approval/);
    } finally {
      await new Promise<void>((resolve) =>
        gateway.wss.close(() => resolve())
      );
      await new Promise<void>((resolve) =>
        gateway.server.close(() => resolve())
      );
    }
  });

  it("permanent revoke does not become transferable", async () => {
    const registry = await DeviceRegistry.open();
    const viewerGrants =
      new DeviceViewerGrantRegistry();
    await claimedDevice(
      registry,
      "device-revoked",
      "account:old"
    );

    await registry.revokeDevice("device-revoked");
    await expect(
      registry.releaseDeviceForTransfer(
        "device-revoked"
      )
    ).rejects.toThrow(/cannot be released/);
  });
});
