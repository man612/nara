import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type DeviceLifecycleState =
  | "unclaimed"
  | "claim_pending"
  | "active"
  | "revoked";

export type DeviceRole = "admin" | "member";

export type DeviceRecord = {
  deviceId: string;
  clientId?: string;
  state: DeviceLifecycleState;
  credentialHash?: string;
  credentialGeneration: number;
  accountId?: string;
  role?: DeviceRole;
  createdAt: string;
  updatedAt: string;
};

type ClaimRecord = {
  claimId: string;
  deviceId: string;
  claimTokenHash: string;
  userCode: string;
  expiresAt: string;
  accountApprovedAt?: string;
  physicalApprovedAt?: string;
  accountId?: string;
  role?: DeviceRole;
};

type RegistrySnapshot = {
  version: 1;
  devices: DeviceRecord[];
  claims: ClaimRecord[];
};

export type ClaimStart = {
  claimId: string;
  claimToken: string;
  userCode: string;
  expiresAt: string;
};

export type DeviceCredential = {
  deviceId: string;
  credential: string;
  generation: number;
};

export type DeviceRegistryOptions = {
  filePath?: string;
  now?: () => number;
};

const CLAIM_TOKEN_BYTES = 32;
const DEVICE_CREDENTIAL_BYTES = 32;
const DEFAULT_CLAIM_TTL_MS = 5 * 60 * 1000;
const USER_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function secureHashEqual(expectedHex: string, actualSecret: string): boolean {
  const expected = Buffer.from(expectedHex, "hex");
  const actual = Buffer.from(hashSecret(actualSecret), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function createUserCode(length = 8): string {
  let code = "";
  for (let index = 0; index < length; index += 1) {
    code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  }
  return code;
}

function assertNonEmpty(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${name} must not be empty`);
  }
}

function validateSnapshot(value: unknown): RegistrySnapshot {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { version?: unknown }).version !== 1 ||
    !Array.isArray((value as { devices?: unknown }).devices) ||
    !Array.isArray((value as { claims?: unknown }).claims)
  ) {
    throw new Error("Invalid device registry snapshot");
  }

  const snapshot = value as RegistrySnapshot;
  for (const device of snapshot.devices) {
    assertNonEmpty(device.deviceId, "deviceId");
    if (
      !["unclaimed", "claim_pending", "active", "revoked"].includes(device.state) ||
      !Number.isInteger(device.credentialGeneration) ||
      device.credentialGeneration < 0
    ) {
      throw new Error("Invalid device registry record");
    }
  }

  for (const claim of snapshot.claims) {
    assertNonEmpty(claim.claimId, "claimId");
    assertNonEmpty(claim.deviceId, "claim deviceId");
    assertNonEmpty(claim.claimTokenHash, "claimTokenHash");
    assertNonEmpty(claim.userCode, "userCode");
    if (!Number.isFinite(Date.parse(claim.expiresAt))) {
      throw new Error("Invalid claim expiry");
    }
  }

  return snapshot;
}

export class DeviceRegistry {
  private readonly devices = new Map<string, DeviceRecord>();
  private readonly claims = new Map<string, ClaimRecord>();
  private readonly now: () => number;
  private readonly filePath: string | undefined;
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(options: DeviceRegistryOptions = {}) {
    this.filePath = options.filePath;
    this.now = options.now ?? Date.now;
  }

  static async open(options: DeviceRegistryOptions = {}): Promise<DeviceRegistry> {
    const registry = new DeviceRegistry(options);
    await registry.load();
    return registry;
  }

  getDevice(deviceId: string): DeviceRecord | undefined {
    const record = this.devices.get(deviceId);
    return record ? structuredClone(record) : undefined;
  }

  getDeviceState(deviceId: string): DeviceLifecycleState | undefined {
    return this.devices.get(deviceId)?.state;
  }

  listDevices(): DeviceRecord[] {
    return [...this.devices.values()].map((record) =>
      structuredClone(record)
    );
  }

  registerUnclaimedDevice(input: {
    deviceId: string;
    clientId?: string;
  }): Promise<DeviceRecord> {
    assertNonEmpty(input.deviceId, "deviceId");
    const existing = this.devices.get(input.deviceId);
    const now = new Date(this.now()).toISOString();

    if (existing) {
      if (existing.state === "revoked") {
        throw new Error("Revoked device cannot be silently re-registered");
      }
      if (input.clientId && existing.clientId !== input.clientId) {
        existing.clientId = input.clientId;
        existing.updatedAt = now;
        return this.persist().then(() => structuredClone(existing));
      }
      return Promise.resolve(structuredClone(existing));
    }

    const created: DeviceRecord = {
      deviceId: input.deviceId,
      ...(input.clientId ? { clientId: input.clientId } : {}),
      state: "unclaimed",
      credentialGeneration: 0,
      createdAt: now,
      updatedAt: now
    };
    this.devices.set(created.deviceId, created);
    return this.persist().then(() => structuredClone(created));
  }

  async beginClaim(
    deviceId: string,
    options: { ttlMs?: number } = {}
  ): Promise<ClaimStart> {
    const device = this.devices.get(deviceId);
    if (!device) {
      throw new Error("Unknown device");
    }
    if (device.state === "active") {
      throw new Error("Device is already claimed");
    }
    if (device.state === "revoked") {
      throw new Error("Revoked device cannot be claimed");
    }

    const ttlMs = options.ttlMs ?? DEFAULT_CLAIM_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("Claim TTL must be positive");
    }

    for (const [claimId, claim] of this.claims) {
      if (claim.deviceId === deviceId) {
        this.claims.delete(claimId);
      }
    }

    const claimToken = randomBytes(CLAIM_TOKEN_BYTES).toString("base64url");
    const claim: ClaimRecord = {
      claimId: randomUUID(),
      deviceId,
      claimTokenHash: hashSecret(claimToken),
      userCode: createUserCode(),
      expiresAt: new Date(this.now() + ttlMs).toISOString()
    };
    this.claims.set(claim.claimId, claim);
    device.state = "claim_pending";
    device.updatedAt = new Date(this.now()).toISOString();

    await this.persist();
    return {
      claimId: claim.claimId,
      claimToken,
      userCode: claim.userCode,
      expiresAt: claim.expiresAt
    };
  }

  async approveClaimFromAccount(input: {
    claimId: string;
    claimToken: string;
    accountId: string;
    role?: DeviceRole;
  }): Promise<void> {
    assertNonEmpty(input.accountId, "accountId");
    const claim = await this.requireLiveClaim(input.claimId);
    if (!secureHashEqual(claim.claimTokenHash, input.claimToken)) {
      throw new Error("Invalid claim token");
    }

    claim.accountApprovedAt = new Date(this.now()).toISOString();
    claim.accountId = input.accountId;
    claim.role = input.role ?? "admin";
    await this.persist();
  }

  async confirmPhysicalClaim(input: {
    claimId: string;
    deviceId: string;
  }): Promise<void> {
    const claim = await this.requireLiveClaim(input.claimId);
    if (claim.deviceId !== input.deviceId) {
      throw new Error("Claim is bound to a different device");
    }

    claim.physicalApprovedAt = new Date(this.now()).toISOString();
    await this.persist();
  }

  async completeClaim(input: {
    claimId: string;
    deviceId: string;
  }): Promise<DeviceCredential> {
    const claim = await this.requireLiveClaim(input.claimId);
    if (claim.deviceId !== input.deviceId) {
      throw new Error("Claim is bound to a different device");
    }
    if (!claim.accountApprovedAt || !claim.accountId || !claim.role) {
      throw new Error("Account approval is required");
    }
    if (!claim.physicalApprovedAt) {
      throw new Error("Physical approval is required");
    }

    const device = this.devices.get(input.deviceId);
    if (!device || device.state === "revoked") {
      throw new Error("Device cannot complete claim");
    }

    const credential = randomBytes(DEVICE_CREDENTIAL_BYTES).toString("base64url");
    device.state = "active";
    device.accountId = claim.accountId;
    device.role = claim.role;
    device.credentialGeneration += 1;
    device.credentialHash = hashSecret(credential);
    device.updatedAt = new Date(this.now()).toISOString();
    this.claims.delete(claim.claimId);

    await this.persist();
    return {
      deviceId: device.deviceId,
      credential,
      generation: device.credentialGeneration
    };
  }

  verifyDeviceCredential(deviceId: string, credential: string): boolean {
    const device = this.devices.get(deviceId);
    if (
      !device ||
      device.state !== "active" ||
      !device.credentialHash ||
      credential.length === 0
    ) {
      return false;
    }
    return secureHashEqual(device.credentialHash, credential);
  }

  async rotateCredential(deviceId: string): Promise<DeviceCredential> {
    const device = this.devices.get(deviceId);
    if (!device || device.state !== "active") {
      throw new Error("Only an active device can rotate credentials");
    }

    const credential = randomBytes(DEVICE_CREDENTIAL_BYTES).toString("base64url");
    device.credentialGeneration += 1;
    device.credentialHash = hashSecret(credential);
    device.updatedAt = new Date(this.now()).toISOString();
    await this.persist();

    return {
      deviceId,
      credential,
      generation: device.credentialGeneration
    };
  }

  async revokeDevice(deviceId: string): Promise<void> {
    const device = this.devices.get(deviceId);
    if (!device) {
      throw new Error("Unknown device");
    }

    device.state = "revoked";
    delete device.credentialHash;
    device.updatedAt = new Date(this.now()).toISOString();
    for (const [claimId, claim] of this.claims) {
      if (claim.deviceId === deviceId) {
        this.claims.delete(claimId);
      }
    }
    await this.persist();
  }

  private async requireLiveClaim(claimId: string): Promise<ClaimRecord> {
    const claim = this.claims.get(claimId);
    if (!claim) {
      throw new Error("Unknown or already-consumed claim");
    }

    if (Date.parse(claim.expiresAt) <= this.now()) {
      this.claims.delete(claimId);
      const device = this.devices.get(claim.deviceId);
      if (device?.state === "claim_pending") {
        device.state = "unclaimed";
        device.updatedAt = new Date(this.now()).toISOString();
      }
      await this.persist();
      throw new Error("Claim has expired");
    }

    return claim;
  }

  private async load(): Promise<void> {
    if (!this.filePath) return;

    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }

    const snapshot = validateSnapshot(JSON.parse(raw) as unknown);
    this.devices.clear();
    this.claims.clear();
    for (const device of snapshot.devices) {
      this.devices.set(device.deviceId, structuredClone(device));
    }
    for (const claim of snapshot.claims) {
      this.claims.set(claim.claimId, structuredClone(claim));
    }
  }

  private persist(): Promise<void> {
    if (!this.filePath) {
      return Promise.resolve();
    }

    const target = this.filePath;
    const snapshot: RegistrySnapshot = {
      version: 1,
      devices: Array.from(this.devices.values(), (device) => structuredClone(device)),
      claims: Array.from(this.claims.values(), (claim) => structuredClone(claim))
    };

    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(target), { recursive: true });
      const temporary = `${target}.tmp`;
      await writeFile(temporary, JSON.stringify(snapshot, null, 2) + "\n", {
        encoding: "utf8",
        mode: 0o600
      });
      await rename(temporary, target);
    });

    return this.writeChain;
  }
}

export function bearerTokenFromAuthorization(
  authorization: string | undefined
): string | undefined {
  if (!authorization) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1];
}
