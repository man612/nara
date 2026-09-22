import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeviceRegistry } from "../src/device/registry.js";

const tempDirs: string[] = [];

async function tempRegistry(now?: () => number) {
  const directory = await mkdtemp(join(tmpdir(), "nara-device-registry-"));
  tempDirs.push(directory);
  const filePath = join(directory, "devices.json");
  return {
    registry: await DeviceRegistry.open({ filePath, ...(now ? { now } : {}) }),
    filePath
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("device claim registry", () => {
  it("requires both account approval and physical approval before issuing a credential", async () => {
    const { registry } = await tempRegistry();
    await registry.registerUnclaimedDevice({
      deviceId: "AA:BB:CC:DD:EE:01",
      clientId: "client-1"
    });

    const claim = await registry.beginClaim("AA:BB:CC:DD:EE:01");
    await registry.approveClaimFromAccount({
      claimId: claim.claimId,
      claimToken: claim.claimToken,
      accountId: "account-partner"
    });

    await expect(
      registry.completeClaim({
        claimId: claim.claimId,
        deviceId: "AA:BB:CC:DD:EE:01"
      })
    ).rejects.toThrow(/Physical approval/);

    await registry.confirmPhysicalClaim({
      claimId: claim.claimId,
      deviceId: "AA:BB:CC:DD:EE:01"
    });

    const issued = await registry.completeClaim({
      claimId: claim.claimId,
      deviceId: "AA:BB:CC:DD:EE:01"
    });

    expect(issued.credential.length).toBeGreaterThan(30);
    expect(
      registry.verifyDeviceCredential(
        "AA:BB:CC:DD:EE:01",
        issued.credential
      )
    ).toBe(true);
    expect(registry.getDevice("AA:BB:CC:DD:EE:01")).toMatchObject({
      state: "active",
      accountId: "account-partner",
      role: "admin",
      credentialGeneration: 1
    });
  });

  it("binds a claim to exactly one physical device", async () => {
    const { registry } = await tempRegistry();
    await registry.registerUnclaimedDevice({ deviceId: "device-a" });
    await registry.registerUnclaimedDevice({ deviceId: "device-b" });

    const claim = await registry.beginClaim("device-a");

    await expect(
      registry.confirmPhysicalClaim({
        claimId: claim.claimId,
        deviceId: "device-b"
      })
    ).rejects.toThrow(/different device/);
  });

  it("rejects a wrong claim token and does not accept claim replay after completion", async () => {
    const { registry } = await tempRegistry();
    await registry.registerUnclaimedDevice({ deviceId: "device-a" });
    const claim = await registry.beginClaim("device-a");

    await expect(
      registry.approveClaimFromAccount({
        claimId: claim.claimId,
        claimToken: "wrong",
        accountId: "account-1"
      })
    ).rejects.toThrow(/Invalid claim token/);

    await registry.approveClaimFromAccount({
      claimId: claim.claimId,
      claimToken: claim.claimToken,
      accountId: "account-1"
    });
    await registry.confirmPhysicalClaim({
      claimId: claim.claimId,
      deviceId: "device-a"
    });
    await registry.completeClaim({
      claimId: claim.claimId,
      deviceId: "device-a"
    });

    await expect(
      registry.approveClaimFromAccount({
        claimId: claim.claimId,
        claimToken: claim.claimToken,
        accountId: "account-1"
      })
    ).rejects.toThrow(/already-consumed/);
  });

  it("expires short-lived claim transactions", async () => {
    let clock = Date.parse("2026-09-21T10:00:00.000Z");
    const { registry } = await tempRegistry(() => clock);
    await registry.registerUnclaimedDevice({ deviceId: "device-a" });

    const claim = await registry.beginClaim("device-a", { ttlMs: 1000 });
    clock += 1001;

    await expect(
      registry.approveClaimFromAccount({
        claimId: claim.claimId,
        claimToken: claim.claimToken,
        accountId: "account-1"
      })
    ).rejects.toThrow(/expired/);

    expect(registry.getDeviceState("device-a")).toBe("unclaimed");
  });

  it("rotation invalidates the previous credential and revoke invalidates the current credential", async () => {
    const { registry } = await tempRegistry();
    await registry.registerUnclaimedDevice({ deviceId: "device-a" });
    const claim = await registry.beginClaim("device-a");
    await registry.approveClaimFromAccount({
      claimId: claim.claimId,
      claimToken: claim.claimToken,
      accountId: "account-1"
    });
    await registry.confirmPhysicalClaim({
      claimId: claim.claimId,
      deviceId: "device-a"
    });
    const first = await registry.completeClaim({
      claimId: claim.claimId,
      deviceId: "device-a"
    });

    const second = await registry.rotateCredential("device-a");

    expect(registry.verifyDeviceCredential("device-a", first.credential)).toBe(false);
    expect(registry.verifyDeviceCredential("device-a", second.credential)).toBe(true);
    expect(second.generation).toBe(2);

    await registry.revokeDevice("device-a");
    expect(registry.verifyDeviceCredential("device-a", second.credential)).toBe(false);
    expect(registry.getDeviceState("device-a")).toBe("revoked");
  });

  it("fails closed after a persistence error and recovers from the durable snapshot", async () => {
    const { registry, filePath } = await tempRegistry();
    await registry.registerUnclaimedDevice({ deviceId: "device-a" });

    const directory = dirname(filePath);
    const displaced = `${directory}-durable`;
    await rename(directory, displaced);
    await writeFile(directory, "blocker", "utf8");

    try {
      await expect(registry.beginClaim("device-a")).rejects.toThrow();
      expect(registry.isHealthy()).toBe(false);
      expect(() => registry.getDeviceState("device-a")).toThrow(
        /storage is unavailable/
      );
      expect(() =>
        registry.verifyDeviceCredential("device-a", "anything")
      ).toThrow(/storage is unavailable/);
    } finally {
      await rm(directory, { force: true });
      await rename(displaced, directory);
    }

    const reopened = await DeviceRegistry.open({ filePath });
    expect(reopened.isHealthy()).toBe(true);
    expect(reopened.getDeviceState("device-a")).toBe("unclaimed");
  });

  it("persists only hashed secrets and survives restart", async () => {
    const { registry, filePath } = await tempRegistry();
    await registry.registerUnclaimedDevice({
      deviceId: "device-a",
      clientId: "client-a"
    });
    const claim = await registry.beginClaim("device-a");
    await registry.approveClaimFromAccount({
      claimId: claim.claimId,
      claimToken: claim.claimToken,
      accountId: "account-1"
    });
    await registry.confirmPhysicalClaim({
      claimId: claim.claimId,
      deviceId: "device-a"
    });
    const issued = await registry.completeClaim({
      claimId: claim.claimId,
      deviceId: "device-a"
    });

    const raw = await readFile(filePath, "utf8");
    expect(raw).not.toContain(claim.claimToken);
    expect(raw).not.toContain(issued.credential);

    const reopened = await DeviceRegistry.open({ filePath });
    expect(reopened.verifyDeviceCredential("device-a", issued.credential)).toBe(true);
    expect(reopened.getDevice("device-a")).toMatchObject({
      clientId: "client-a",
      state: "active",
      accountId: "account-1"
    });
  });
});
