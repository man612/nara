import { describe, expect, it } from "vitest";
import { DeviceViewerGrantRegistry } from "../src/identity/device-viewer-grants.js";

describe("DeviceViewerGrantRegistry", () => {
  it("expires trusted viewer grants instead of keeping private access forever", () => {
    let now = Date.parse("2026-09-22T00:00:00.000Z");
    const registry = new DeviceViewerGrantRegistry(() => now);

    const grant = registry.grant(
      "device-1",
      {
        personId: "person:partner",
        accountId: "account:partner"
      },
      { ttlMs: 60_000 }
    );
    expect(grant.expiresAt).toBe("2026-09-22T00:01:00.000Z");
    expect(registry.resolve("device-1")).toEqual({
      personId: "person:partner",
      accountId: "account:partner"
    });

    now += 60_001;
    expect(registry.resolve("device-1")).toBeUndefined();
  });

  it("lets an explicit later grant replace the current device viewer", () => {
    const registry = new DeviceViewerGrantRegistry();
    registry.grant("device-1", { personId: "person:partner" });
    registry.grant("device-1", { personId: "person:creator" });
    expect(registry.resolve("device-1")).toEqual({
      personId: "person:creator"
    });
  });
});
