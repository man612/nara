import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type HumanCredentialRecord = {
  credentialId: string;
  personId: string;
  accountId?: string;
  credentialHash: string;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
};

type HumanCredentialSnapshot = {
  version: 1;
  credentials: HumanCredentialRecord[];
};

type HumanSession = {
  tokenHash: string;
  personId: string;
  accountId?: string;
  expiresAtMs: number;
};

export type IssuedHumanCredential = {
  credentialId: string;
  credential: string;
  personId: string;
  accountId?: string;
};

export type HumanViewerIdentity = {
  personId: string;
  accountId?: string;
};

export type HumanCredentialRegistryOptions = {
  filePath?: string;
  now?: () => number;
};

const CREDENTIAL_BYTES = 32;
const SESSION_BYTES = 32;
const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;
const MAX_SESSION_TTL_MS = 60 * 60 * 1000;

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function secureHashEqual(expectedHex: string, actualSecret: string): boolean {
  const expected = Buffer.from(expectedHex, "hex");
  const actual = Buffer.from(hashSecret(actualSecret), "hex");
  return (
    expected.length === actual.length &&
    timingSafeEqual(expected, actual)
  );
}

function requireText(value: string, name: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${name} must not be empty`);
  }
}

function validateSnapshot(value: unknown): HumanCredentialSnapshot {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { version?: unknown }).version !== 1 ||
    !Array.isArray((value as { credentials?: unknown }).credentials)
  ) {
    throw new Error("Invalid human credential snapshot");
  }

  const snapshot = value as HumanCredentialSnapshot;
  for (const record of snapshot.credentials) {
    requireText(record.credentialId, "credentialId");
    requireText(record.personId, "personId");
    requireText(record.credentialHash, "credentialHash");
    if (
      !Number.isFinite(Date.parse(record.createdAt)) ||
      !Number.isFinite(Date.parse(record.updatedAt)) ||
      (record.revokedAt !== undefined &&
        !Number.isFinite(Date.parse(record.revokedAt)))
    ) {
      throw new Error("Invalid human credential timestamps");
    }
  }
  return snapshot;
}

export class HumanCredentialRegistry {
  private readonly credentials = new Map<string, HumanCredentialRecord>();
  private readonly sessions = new Map<string, HumanSession>();
  private readonly filePath: string | undefined;
  private readonly now: () => number;
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(options: HumanCredentialRegistryOptions = {}) {
    this.filePath = options.filePath;
    this.now = options.now ?? Date.now;
  }

  static async open(
    options: HumanCredentialRegistryOptions = {}
  ): Promise<HumanCredentialRegistry> {
    const registry = new HumanCredentialRegistry(options);
    await registry.load();
    return registry;
  }

  async issue(input: {
    personId: string;
    accountId?: string;
  }): Promise<IssuedHumanCredential> {
    requireText(input.personId, "personId");
    if (input.accountId !== undefined) {
      requireText(input.accountId, "accountId");
    }

    const credential = randomBytes(CREDENTIAL_BYTES).toString("base64url");
    const now = new Date(this.now()).toISOString();
    const record: HumanCredentialRecord = {
      credentialId: randomUUID(),
      personId: input.personId,
      ...(input.accountId ? { accountId: input.accountId } : {}),
      credentialHash: hashSecret(credential),
      createdAt: now,
      updatedAt: now
    };
    this.credentials.set(record.credentialId, record);
    await this.persist();

    return {
      credentialId: record.credentialId,
      credential,
      personId: record.personId,
      ...(record.accountId ? { accountId: record.accountId } : {})
    };
  }

  async revoke(credentialId: string): Promise<void> {
    requireText(credentialId, "credentialId");
    const record = this.credentials.get(credentialId);
    if (!record) {
      throw new Error("Unknown human credential");
    }
    if (!record.revokedAt) {
      const now = new Date(this.now()).toISOString();
      record.revokedAt = now;
      record.updatedAt = now;
      await this.persist();
    }

    for (const [tokenHash, session] of this.sessions) {
      if (
        session.personId === record.personId &&
        session.accountId === record.accountId
      ) {
        this.sessions.delete(tokenHash);
      }
    }
  }

  verifyCredential(credential: string): HumanViewerIdentity | undefined {
    if (!credential) return undefined;
    for (const record of this.credentials.values()) {
      if (
        !record.revokedAt &&
        secureHashEqual(record.credentialHash, credential)
      ) {
        return {
          personId: record.personId,
          ...(record.accountId ? { accountId: record.accountId } : {})
        };
      }
    }
    return undefined;
  }

  mintSession(
    credential: string,
    options: { ttlMs?: number } = {}
  ): { token: string; expiresAt: string; viewer: HumanViewerIdentity } {
    const viewer = this.verifyCredential(credential);
    if (!viewer) {
      throw new Error("Invalid or revoked human credential");
    }

    const ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    if (
      !Number.isFinite(ttlMs) ||
      ttlMs <= 0 ||
      ttlMs > MAX_SESSION_TTL_MS
    ) {
      throw new Error("Human session TTL is outside the allowed range");
    }

    this.pruneSessions();
    const token = randomBytes(SESSION_BYTES).toString("base64url");
    const expiresAtMs = this.now() + ttlMs;
    this.sessions.set(hashSecret(token), {
      tokenHash: hashSecret(token),
      personId: viewer.personId,
      ...(viewer.accountId ? { accountId: viewer.accountId } : {}),
      expiresAtMs
    });

    return {
      token,
      expiresAt: new Date(expiresAtMs).toISOString(),
      viewer
    };
  }

  resolveSession(token: string): HumanViewerIdentity | undefined {
    if (!token) return undefined;
    this.pruneSessions();
    const session = this.sessions.get(hashSecret(token));
    if (!session || session.expiresAtMs <= this.now()) {
      return undefined;
    }
    return {
      personId: session.personId,
      ...(session.accountId ? { accountId: session.accountId } : {})
    };
  }

  private pruneSessions(): void {
    const now = this.now();
    for (const [tokenHash, session] of this.sessions) {
      if (session.expiresAtMs <= now) {
        this.sessions.delete(tokenHash);
      }
    }
  }

  private async load(): Promise<void> {
    if (!this.filePath) return;

    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return;
      }
      throw error;
    }

    const snapshot = validateSnapshot(JSON.parse(raw) as unknown);
    for (const record of snapshot.credentials) {
      if (this.credentials.has(record.credentialId)) {
        throw new Error("Duplicate human credential ID");
      }
      this.credentials.set(record.credentialId, structuredClone(record));
    }
  }

  private persist(): Promise<void> {
    if (!this.filePath) return Promise.resolve();

    this.writeChain = this.writeChain.then(async () => {
      const snapshot: HumanCredentialSnapshot = {
        version: 1,
        credentials: [...this.credentials.values()].map((record) =>
          structuredClone(record)
        )
      };
      await mkdir(dirname(this.filePath!), { recursive: true });
      const tempPath = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(
        tempPath,
        JSON.stringify(snapshot, null, 2) + "\n",
        { mode: 0o600 }
      );
      await rename(tempPath, this.filePath!);
    });
    return this.writeChain;
  }
}
