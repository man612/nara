import type { HumanViewerIdentity } from "./human-credentials.js";

export type DeviceViewerGrant = HumanViewerIdentity & {
  deviceId: string;
  issuedAt: string;
  expiresAt: string;
};

const DEFAULT_GRANT_TTL_MS = 10 * 60 * 1000;
const MAX_GRANT_TTL_MS = 60 * 60 * 1000;

export class DeviceViewerGrantRegistry {
  private readonly grants = new Map<string, DeviceViewerGrant>();

  constructor(private readonly now: () => number = Date.now) {}

  grant(
    deviceIdInput: string,
    viewer: HumanViewerIdentity,
    options: { ttlMs?: number } = {}
  ): DeviceViewerGrant {
    const deviceId = deviceIdInput.trim();
    if (!deviceId) {
      throw new Error("deviceId must not be empty");
    }
    if (!viewer.personId.trim()) {
      throw new Error("viewer personId must not be empty");
    }
    const ttlMs = options.ttlMs ?? DEFAULT_GRANT_TTL_MS;
    if (
      !Number.isFinite(ttlMs) ||
      ttlMs <= 0 ||
      ttlMs > MAX_GRANT_TTL_MS
    ) {
      throw new Error("Viewer grant TTL is outside the allowed range");
    }

    const issuedAtMs = this.now();
    const grant: DeviceViewerGrant = {
      deviceId,
      personId: viewer.personId,
      ...(viewer.accountId ? { accountId: viewer.accountId } : {}),
      issuedAt: new Date(issuedAtMs).toISOString(),
      expiresAt: new Date(issuedAtMs + ttlMs).toISOString()
    };
    this.grants.set(deviceId, grant);
    return structuredClone(grant);
  }

  resolve(deviceIdInput: string | undefined): HumanViewerIdentity | undefined {
    if (!deviceIdInput) return undefined;
    const deviceId = deviceIdInput.trim();
    if (!deviceId) return undefined;

    const grant = this.grants.get(deviceId);
    if (!grant) return undefined;
    if (Date.parse(grant.expiresAt) <= this.now()) {
      this.grants.delete(deviceId);
      return undefined;
    }
    return {
      personId: grant.personId,
      ...(grant.accountId ? { accountId: grant.accountId } : {})
    };
  }

  inspect(deviceIdInput: string): DeviceViewerGrant | undefined {
    const viewer = this.resolve(deviceIdInput);
    if (!viewer) return undefined;
    const grant = this.grants.get(deviceIdInput.trim());
    return grant ? structuredClone(grant) : undefined;
  }

  revoke(deviceIdInput: string): boolean {
    const deviceId = deviceIdInput.trim();
    if (!deviceId) return false;
    return this.grants.delete(deviceId);
  }
}
