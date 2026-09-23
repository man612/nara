import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify as verifySignature
} from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { HumanViewerIdentity } from "./human-credentials.js";

const PASSKEY_ENROLLMENT_BYTES = 32;
const CHALLENGE_BYTES = 32;
const USER_HANDLE_BYTES = 32;
const DEFAULT_ENROLLMENT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CEREMONY_TTL_MS = 5 * 60 * 1000;
const MAX_ENROLLMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CREDENTIALS_PER_PERSON = 8;
const MAX_WEBAUTHN_BLOB_BYTES = 32 * 1024;

const PasskeyTransportSchema = z.enum([
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb"
]);

const PasskeyRecordSchema = z.object({
  credentialId: z.string().min(1),
  personId: z.string().min(1),
  accountId: z.string().min(1).optional(),
  userHandle: z.string().min(1),
  publicKeySpki: z.string().min(1),
  algorithm: z.enum(["ES256", "RS256", "Ed25519"]),
  counter: z.number().int().nonnegative(),
  transports: z.array(PasskeyTransportSchema).max(16).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().optional(),
  revokedAt: z.string().datetime().optional()
});

const EnrollmentSchema = z.object({
  enrollmentId: z.string().min(1),
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  personId: z.string().min(1),
  accountId: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime()
});

const SnapshotSchema = z.object({
  version: z.literal(1),
  passkeys: z.array(PasskeyRecordSchema),
  enrollments: z.array(EnrollmentSchema)
});

export type PasskeyTransport = z.infer<typeof PasskeyTransportSchema>;

export type PasskeyRecord = z.infer<typeof PasskeyRecordSchema>;

type EnrollmentRecord = z.infer<typeof EnrollmentSchema>;

type RegistrationCeremony = {
  ceremonyId: string;
  challenge: string;
  enrollmentId: string;
  tokenHash: string;
  personId: string;
  accountId?: string;
  userHandle: string;
  expiresAtMs: number;
};

type AuthenticationCeremony = {
  ceremonyId: string;
  challenge: string;
  expiresAtMs: number;
};

export type PasskeyRegistrationCredential = {
  id: string;
  rawId?: string;
  type: "public-key";
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports?: PasskeyTransport[];
  };
};

export type PasskeyAuthenticationCredential = {
  id: string;
  rawId?: string;
  type: "public-key";
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string | null;
  };
};

export type PasskeyRegistrationOptions = {
  ceremonyId: string;
  publicKey: {
    challenge: string;
    rp: {
      id: string;
      name: string;
    };
    user: {
      id: string;
      name: string;
      displayName: string;
    };
    pubKeyCredParams: Array<{
      type: "public-key";
      alg: number;
    }>;
    timeout: number;
    attestation: "none";
    authenticatorSelection: {
      residentKey: "required";
      requireResidentKey: true;
      userVerification: "required";
    };
    excludeCredentials: Array<{
      type: "public-key";
      id: string;
      transports?: PasskeyTransport[];
    }>;
  };
};

export type PasskeyAuthenticationOptions = {
  ceremonyId: string;
  publicKey: {
    challenge: string;
    rpId: string;
    timeout: number;
    userVerification: "required";
  };
};

export type PasskeyRegistryOptions = {
  filePath: string;
  rpId: string;
  rpName?: string;
  origins: string[];
  now?: () => number;
  enrollmentTtlMs?: number;
  ceremonyTtlMs?: number;
};

type CborResult = {
  value: unknown;
  offset: number;
};

type ParsedAuthenticatorData = {
  flags: number;
  counter: number;
  credentialId?: Uint8Array;
  publicKeySpki?: string;
  algorithm?: PasskeyRecord["algorithm"];
};

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

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function decodeBase64url(value: string, field: string): Uint8Array {
  if (
    !value ||
    value.length > Math.ceil((MAX_WEBAUTHN_BLOB_BYTES * 4) / 3) + 8 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new Error(field + " is not valid base64url");
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length === 0 || bytes.length > MAX_WEBAUTHN_BLOB_BYTES) {
    throw new Error(field + " is outside the allowed size");
  }
  return new Uint8Array(bytes);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function readUnsigned(
  bytes: Uint8Array,
  offset: number,
  length: number
): number {
  if (offset + length > bytes.length) {
    throw new Error("CBOR value is truncated");
  }
  let value = 0;
  for (let index = 0; index < length; index += 1) {
    value = value * 256 + bytes[offset + index]!;
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error("CBOR integer is too large");
  }
  return value;
}

function readCborLength(
  bytes: Uint8Array,
  offset: number,
  additional: number
): { length: number; offset: number } {
  if (additional < 24) {
    return { length: additional, offset };
  }
  if (additional === 24) {
    return {
      length: readUnsigned(bytes, offset, 1),
      offset: offset + 1
    };
  }
  if (additional === 25) {
    return {
      length: readUnsigned(bytes, offset, 2),
      offset: offset + 2
    };
  }
  if (additional === 26) {
    return {
      length: readUnsigned(bytes, offset, 4),
      offset: offset + 4
    };
  }
  if (additional === 27) {
    return {
      length: readUnsigned(bytes, offset, 8),
      offset: offset + 8
    };
  }
  throw new Error("Indefinite or reserved CBOR lengths are not supported");
}

function decodeCbor(
  bytes: Uint8Array,
  startOffset = 0,
  depth = 0
): CborResult {
  if (depth > 16) {
    throw new Error("CBOR nesting is too deep");
  }
  if (startOffset >= bytes.length) {
    throw new Error("CBOR value is missing");
  }

  const first = bytes[startOffset]!;
  const major = first >> 5;
  const additional = first & 0x1f;
  let offset = startOffset + 1;

  if (major === 0 || major === 1) {
    const decoded = readCborLength(bytes, offset, additional);
    const value = major === 0 ? decoded.length : -1 - decoded.length;
    return { value, offset: decoded.offset };
  }

  if (major === 2 || major === 3) {
    const decoded = readCborLength(bytes, offset, additional);
    offset = decoded.offset;
    if (decoded.length > MAX_WEBAUTHN_BLOB_BYTES) {
      throw new Error("CBOR string is too large");
    }
    const end = offset + decoded.length;
    if (end > bytes.length) {
      throw new Error("CBOR string is truncated");
    }
    const slice = bytes.slice(offset, end);
    return {
      value:
        major === 2
          ? slice
          : new TextDecoder("utf-8", { fatal: true }).decode(slice),
      offset: end
    };
  }

  if (major === 4) {
    const decoded = readCborLength(bytes, offset, additional);
    offset = decoded.offset;
    if (decoded.length > 256) {
      throw new Error("CBOR array is too large");
    }
    const values: unknown[] = [];
    for (let index = 0; index < decoded.length; index += 1) {
      const child = decodeCbor(bytes, offset, depth + 1);
      values.push(child.value);
      offset = child.offset;
    }
    return { value: values, offset };
  }

  if (major === 5) {
    const decoded = readCborLength(bytes, offset, additional);
    offset = decoded.offset;
    if (decoded.length > 256) {
      throw new Error("CBOR map is too large");
    }
    const values = new Map<unknown, unknown>();
    for (let index = 0; index < decoded.length; index += 1) {
      const key = decodeCbor(bytes, offset, depth + 1);
      offset = key.offset;
      const value = decodeCbor(bytes, offset, depth + 1);
      offset = value.offset;
      values.set(key.value, value.value);
    }
    return { value: values, offset };
  }

  if (major === 7) {
    if (additional === 20) return { value: false, offset };
    if (additional === 21) return { value: true, offset };
    if (additional === 22) return { value: null, offset };
  }

  throw new Error("Unsupported CBOR value");
}

function requireCborMap(value: unknown, name: string): Map<unknown, unknown> {
  if (!(value instanceof Map)) {
    throw new Error(name + " must be a CBOR map");
  }
  return value;
}

function toPublicKey(
  coseValue: unknown
): {
  publicKeySpki: string;
  algorithm: PasskeyRecord["algorithm"];
} {
  const cose = requireCborMap(coseValue, "credentialPublicKey");
  const kty = cose.get(1);
  const alg = cose.get(3);

  if (kty === 2 && alg === -7) {
    const crv = cose.get(-1);
    const x = cose.get(-2);
    const y = cose.get(-3);
    if (
      crv !== 1 ||
      !(x instanceof Uint8Array) ||
      !(y instanceof Uint8Array) ||
      x.length !== 32 ||
      y.length !== 32
    ) {
      throw new Error("Unsupported ES256 credential key");
    }
    const key = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: base64url(x),
        y: base64url(y)
      },
      format: "jwk"
    });
    return {
      publicKeySpki: Buffer.from(
        key.export({ format: "der", type: "spki" })
      ).toString("base64url"),
      algorithm: "ES256"
    };
  }

  if (kty === 3 && alg === -257) {
    const n = cose.get(-1);
    const e = cose.get(-2);
    if (!(n instanceof Uint8Array) || !(e instanceof Uint8Array)) {
      throw new Error("Unsupported RS256 credential key");
    }
    const key = createPublicKey({
      key: {
        kty: "RSA",
        n: base64url(n),
        e: base64url(e)
      },
      format: "jwk"
    });
    return {
      publicKeySpki: Buffer.from(
        key.export({ format: "der", type: "spki" })
      ).toString("base64url"),
      algorithm: "RS256"
    };
  }

  if (kty === 1 && alg === -8) {
    const crv = cose.get(-1);
    const x = cose.get(-2);
    if (crv !== 6 || !(x instanceof Uint8Array) || x.length !== 32) {
      throw new Error("Unsupported Ed25519 credential key");
    }
    const key = createPublicKey({
      key: {
        kty: "OKP",
        crv: "Ed25519",
        x: base64url(x)
      },
      format: "jwk"
    });
    return {
      publicKeySpki: Buffer.from(
        key.export({ format: "der", type: "spki" })
      ).toString("base64url"),
      algorithm: "Ed25519"
    };
  }

  throw new Error("Unsupported passkey public-key algorithm");
}

function parseAuthenticatorData(
  data: Uint8Array,
  expectedRpId: string,
  registration: boolean
): ParsedAuthenticatorData {
  if (data.length < 37) {
    throw new Error("authenticatorData is truncated");
  }

  const expectedRpHash = createHash("sha256")
    .update(expectedRpId, "utf8")
    .digest();
  if (!equalBytes(data.slice(0, 32), expectedRpHash)) {
    throw new Error("authenticatorData RP ID hash does not match");
  }

  const flags = data[32]!;
  if ((flags & 0x01) === 0) {
    throw new Error("Passkey user presence is required");
  }
  if ((flags & 0x04) === 0) {
    throw new Error("Passkey user verification is required");
  }

  const counter =
    data[33]! * 0x1000000 +
    data[34]! * 0x10000 +
    data[35]! * 0x100 +
    data[36]!;

  if (!registration) {
    return { flags, counter };
  }

  if ((flags & 0x40) === 0) {
    throw new Error("Registration is missing attested credential data");
  }
  if (data.length < 55) {
    throw new Error("Attested credential data is truncated");
  }

  let offset = 37 + 16;
  const credentialLength = data[offset]! * 256 + data[offset + 1]!;
  offset += 2;
  if (
    credentialLength <= 0 ||
    credentialLength > 4096 ||
    offset + credentialLength >= data.length
  ) {
    throw new Error("Credential ID length is invalid");
  }

  const credentialId = data.slice(offset, offset + credentialLength);
  offset += credentialLength;
  const cose = decodeCbor(data, offset);
  const key = toPublicKey(cose.value);

  return {
    flags,
    counter,
    credentialId,
    publicKeySpki: key.publicKeySpki,
    algorithm: key.algorithm
  };
}

function parseClientData(
  encoded: string,
  expectedType: "webauthn.create" | "webauthn.get",
  expectedChallenge: string,
  origins: Set<string>
): Uint8Array {
  const bytes = decodeBase64url(encoded, "clientDataJSON");
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    throw new Error("clientDataJSON is not valid JSON");
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    throw new Error("clientDataJSON must be an object");
  }
  const data = payload as Record<string, unknown>;
  if (data.type !== expectedType) {
    throw new Error("Unexpected WebAuthn ceremony type");
  }
  if (data.challenge !== expectedChallenge) {
    throw new Error("WebAuthn challenge does not match");
  }
  if (typeof data.origin !== "string" || !origins.has(data.origin)) {
    throw new Error("WebAuthn origin is not allowed");
  }
  if (data.crossOrigin === true || data.topOrigin !== undefined) {
    throw new Error("Cross-origin WebAuthn ceremonies are not allowed");
  }
  return bytes;
}

function normalizeOrigin(originInput: string): string {
  const url = new URL(originInput);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "::1")
    )
  ) {
    throw new Error("WebAuthn origin must use HTTPS outside localhost");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("WebAuthn origin must not contain path/query/fragment");
  }
  return url.origin;
}

function normalizeTransports(value: unknown): PasskeyTransport[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const unique = new Set<PasskeyTransport>();
  for (const raw of value) {
    const parsed = PasskeyTransportSchema.safeParse(raw);
    if (parsed.success) unique.add(parsed.data);
  }
  return unique.size > 0 ? [...unique] : undefined;
}

function parseRegistrationCredential(
  value: unknown
): PasskeyRegistrationCredential {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error("Passkey registration credential is invalid");
  }
  const input = value as Record<string, unknown>;
  const response = input.response;
  if (
    input.type !== "public-key" ||
    typeof input.id !== "string" ||
    (input.rawId !== undefined && typeof input.rawId !== "string") ||
    response === null ||
    typeof response !== "object" ||
    Array.isArray(response)
  ) {
    throw new Error("Passkey registration credential is malformed");
  }
  const result = response as Record<string, unknown>;
  if (
    typeof result.clientDataJSON !== "string" ||
    typeof result.attestationObject !== "string"
  ) {
    throw new Error("Passkey registration response is incomplete");
  }
  const transports = normalizeTransports(result.transports);
  return {
    id: input.id,
    ...(typeof input.rawId === "string" ? { rawId: input.rawId } : {}),
    type: "public-key",
    response: {
      clientDataJSON: result.clientDataJSON,
      attestationObject: result.attestationObject,
      ...(transports ? { transports } : {})
    }
  };
}

function parseAuthenticationCredential(
  value: unknown
): PasskeyAuthenticationCredential {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error("Passkey authentication credential is invalid");
  }
  const input = value as Record<string, unknown>;
  const response = input.response;
  if (
    input.type !== "public-key" ||
    typeof input.id !== "string" ||
    (input.rawId !== undefined && typeof input.rawId !== "string") ||
    response === null ||
    typeof response !== "object" ||
    Array.isArray(response)
  ) {
    throw new Error("Passkey authentication credential is malformed");
  }
  const result = response as Record<string, unknown>;
  if (
    typeof result.clientDataJSON !== "string" ||
    typeof result.authenticatorData !== "string" ||
    typeof result.signature !== "string" ||
    (result.userHandle !== undefined &&
      result.userHandle !== null &&
      typeof result.userHandle !== "string")
  ) {
    throw new Error("Passkey authentication response is incomplete");
  }
  return {
    id: input.id,
    ...(typeof input.rawId === "string" ? { rawId: input.rawId } : {}),
    type: "public-key",
    response: {
      clientDataJSON: result.clientDataJSON,
      authenticatorData: result.authenticatorData,
      signature: result.signature,
      ...(typeof result.userHandle === "string"
        ? { userHandle: result.userHandle }
        : result.userHandle === null
          ? { userHandle: null }
          : {})
    }
  };
}

export class PasskeyRegistry {
  private readonly passkeys = new Map<string, PasskeyRecord>();
  private readonly enrollments = new Map<string, EnrollmentRecord>();
  private readonly registrationCeremonies =
    new Map<string, RegistrationCeremony>();
  private readonly authenticationCeremonies =
    new Map<string, AuthenticationCeremony>();
  private readonly origins: Set<string>;
  private readonly now: () => number;
  private readonly enrollmentTtlMs: number;
  private readonly ceremonyTtlMs: number;
  private writeChain: Promise<void> = Promise.resolve();
  private storageFailure: Error | undefined;

  private constructor(private readonly options: PasskeyRegistryOptions) {
    const rpId = options.rpId.trim().toLowerCase();
    if (
      !rpId ||
      rpId.includes("://") ||
      rpId.includes("/") ||
      rpId.includes(":")
    ) {
      throw new Error("WebAuthn RP ID must be a bare hostname");
    }
    this.options.rpId = rpId;
    this.options.rpName = options.rpName?.trim() || "Nara";
    this.origins = new Set(options.origins.map(normalizeOrigin));
    if (this.origins.size === 0) {
      throw new Error("At least one WebAuthn origin is required");
    }
    for (const origin of this.origins) {
      const host = new URL(origin).hostname.toLowerCase();
      if (host !== rpId && !host.endsWith("." + rpId)) {
        throw new Error(
          "WebAuthn origin host must equal or be below the RP ID"
        );
      }
    }

    this.now = options.now ?? Date.now;
    this.enrollmentTtlMs =
      options.enrollmentTtlMs ?? DEFAULT_ENROLLMENT_TTL_MS;
    this.ceremonyTtlMs =
      options.ceremonyTtlMs ?? DEFAULT_CEREMONY_TTL_MS;
    if (
      this.enrollmentTtlMs <= 0 ||
      this.enrollmentTtlMs > MAX_ENROLLMENT_TTL_MS
    ) {
      throw new Error("Passkey enrollment TTL is outside the allowed range");
    }
    if (
      this.ceremonyTtlMs < 30_000 ||
      this.ceremonyTtlMs > 15 * 60 * 1000
    ) {
      throw new Error("Passkey ceremony TTL is outside the allowed range");
    }
  }

  static async open(options: PasskeyRegistryOptions): Promise<PasskeyRegistry> {
    const registry = new PasskeyRegistry(options);
    await registry.load();
    return registry;
  }

  isHealthy(): boolean {
    return this.storageFailure === undefined;
  }

  async issueEnrollment(input: {
    personId: string;
    accountId?: string;
    ttlMs?: number;
  }): Promise<{
    enrollmentId: string;
    enrollmentToken: string;
    expiresAt: string;
  }> {
    this.assertStorageHealthy();
    const personId = input.personId.trim();
    if (!personId) throw new Error("personId must not be empty");
    if (input.accountId !== undefined && !input.accountId.trim()) {
      throw new Error("accountId must not be empty");
    }
    const ttlMs = input.ttlMs ?? this.enrollmentTtlMs;
    if (
      !Number.isFinite(ttlMs) ||
      ttlMs <= 0 ||
      ttlMs > MAX_ENROLLMENT_TTL_MS
    ) {
      throw new Error("Passkey enrollment TTL is outside the allowed range");
    }

    this.prune();
    const enrollmentToken = randomBytes(
      PASSKEY_ENROLLMENT_BYTES
    ).toString("base64url");
    const createdAtMs = this.now();
    const record: EnrollmentRecord = {
      enrollmentId: randomUUID(),
      tokenHash: hashSecret(enrollmentToken),
      personId,
      ...(input.accountId?.trim()
        ? { accountId: input.accountId.trim() }
        : {}),
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(createdAtMs + ttlMs).toISOString()
    };
    this.enrollments.set(record.enrollmentId, record);
    await this.persist();
    return {
      enrollmentId: record.enrollmentId,
      enrollmentToken,
      expiresAt: record.expiresAt
    };
  }

  getEnrollmentIdentity(
    enrollmentToken: string
  ): HumanViewerIdentity {
    this.assertStorageHealthy();
    const enrollment = this.requireEnrollment(enrollmentToken);
    return {
      personId: enrollment.personId,
      ...(enrollment.accountId
        ? { accountId: enrollment.accountId }
        : {})
    };
  }

  createRegistrationOptions(input: {
    enrollmentToken: string;
    displayName: string;
  }): PasskeyRegistrationOptions {
    this.assertStorageHealthy();
    const enrollment = this.requireEnrollment(input.enrollmentToken);
    const existing = this.activePasskeysForPerson(enrollment.personId);
    if (existing.length >= MAX_CREDENTIALS_PER_PERSON) {
      throw new Error("Too many passkeys are registered for this person");
    }

    const userHandle =
      existing[0]?.userHandle ??
      randomBytes(USER_HANDLE_BYTES).toString("base64url");
    const challenge = randomBytes(CHALLENGE_BYTES).toString("base64url");
    const ceremonyId = randomUUID();
    this.registrationCeremonies.set(ceremonyId, {
      ceremonyId,
      challenge,
      enrollmentId: enrollment.enrollmentId,
      tokenHash: enrollment.tokenHash,
      personId: enrollment.personId,
      ...(enrollment.accountId
        ? { accountId: enrollment.accountId }
        : {}),
      userHandle,
      expiresAtMs: this.now() + this.ceremonyTtlMs
    });

    return {
      ceremonyId,
      publicKey: {
        challenge,
        rp: {
          id: this.options.rpId,
          name: this.options.rpName!
        },
        user: {
          id: userHandle,
          name: enrollment.personId,
          displayName: input.displayName
        },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
          { type: "public-key", alg: -8 }
        ],
        timeout: this.ceremonyTtlMs,
        attestation: "none",
        authenticatorSelection: {
          residentKey: "required",
          requireResidentKey: true,
          userVerification: "required"
        },
        excludeCredentials: existing.map((record) => ({
          type: "public-key" as const,
          id: record.credentialId,
          ...(record.transports
            ? { transports: [...record.transports] }
            : {})
        }))
      }
    };
  }

  async verifyRegistration(input: {
    ceremonyId: string;
    enrollmentToken: string;
    credential: unknown;
  }): Promise<PasskeyRecord> {
    this.assertStorageHealthy();
    this.prune();
    const ceremony = this.registrationCeremonies.get(input.ceremonyId);
    if (!ceremony || ceremony.expiresAtMs <= this.now()) {
      this.registrationCeremonies.delete(input.ceremonyId);
      throw new Error("Registration ceremony is unknown or expired");
    }
    if (!secureHashEqual(ceremony.tokenHash, input.enrollmentToken)) {
      throw new Error("Enrollment token does not match this ceremony");
    }
    const enrollment = this.enrollments.get(ceremony.enrollmentId);
    if (
      !enrollment ||
      Date.parse(enrollment.expiresAt) <= this.now() ||
      !secureHashEqual(enrollment.tokenHash, input.enrollmentToken)
    ) {
      throw new Error("Enrollment token is invalid or expired");
    }

    const credential = parseRegistrationCredential(input.credential);
    const clientData = parseClientData(
      credential.response.clientDataJSON,
      "webauthn.create",
      ceremony.challenge,
      this.origins
    );

    const attestationBytes = decodeBase64url(
      credential.response.attestationObject,
      "attestationObject"
    );
    const attestation = decodeCbor(attestationBytes);
    if (attestation.offset !== attestationBytes.length) {
      throw new Error("Attestation object contains trailing data");
    }
    const attestationMap = requireCborMap(
      attestation.value,
      "attestationObject"
    );
    if (attestationMap.get("fmt") !== "none") {
      throw new Error(
        "Only privacy-preserving none attestation is accepted"
      );
    }
    const attStmt = attestationMap.get("attStmt");
    if (!(attStmt instanceof Map) || attStmt.size !== 0) {
      throw new Error("None attestation must have an empty statement");
    }
    const authData = attestationMap.get("authData");
    if (!(authData instanceof Uint8Array)) {
      throw new Error("Attestation authData is missing");
    }

    // Parsing validates RP ID hash, user presence and user verification.
    const parsed = parseAuthenticatorData(
      authData,
      this.options.rpId,
      true
    );
    if (
      !parsed.credentialId ||
      !parsed.publicKeySpki ||
      !parsed.algorithm
    ) {
      throw new Error("Attested credential key is incomplete");
    }

    const responseId = decodeBase64url(credential.id, "credential id");
    if (!equalBytes(responseId, parsed.credentialId)) {
      throw new Error("Credential ID does not match authenticatorData");
    }
    if (credential.rawId) {
      const rawId = decodeBase64url(credential.rawId, "credential rawId");
      if (!equalBytes(rawId, parsed.credentialId)) {
        throw new Error("Credential rawId does not match authenticatorData");
      }
    }

    // Decode clientData eagerly above so malformed/untrusted JSON cannot be
    // persisted merely because the authenticator data parses.
    void clientData;

    const credentialId = base64url(parsed.credentialId);
    const existing = this.passkeys.get(credentialId);
    if (existing && !existing.revokedAt) {
      throw new Error("This passkey is already registered");
    }

    const now = new Date(this.now()).toISOString();
    const record: PasskeyRecord = {
      credentialId,
      personId: ceremony.personId,
      ...(ceremony.accountId ? { accountId: ceremony.accountId } : {}),
      userHandle: ceremony.userHandle,
      publicKeySpki: parsed.publicKeySpki,
      algorithm: parsed.algorithm,
      counter: parsed.counter,
      ...(credential.response.transports
        ? { transports: credential.response.transports }
        : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    this.passkeys.set(credentialId, record);
    this.registrationCeremonies.delete(ceremony.ceremonyId);
    this.enrollments.delete(ceremony.enrollmentId);
    await this.persist();
    return structuredClone(record);
  }

  createAuthenticationOptions(): PasskeyAuthenticationOptions {
    this.assertStorageHealthy();
    this.prune();
    const challenge = randomBytes(CHALLENGE_BYTES).toString("base64url");
    const ceremonyId = randomUUID();
    this.authenticationCeremonies.set(ceremonyId, {
      ceremonyId,
      challenge,
      expiresAtMs: this.now() + this.ceremonyTtlMs
    });
    return {
      ceremonyId,
      publicKey: {
        challenge,
        rpId: this.options.rpId,
        timeout: this.ceremonyTtlMs,
        userVerification: "required"
      }
    };
  }

  async verifyAuthentication(input: {
    ceremonyId: string;
    credential: unknown;
  }): Promise<HumanViewerIdentity> {
    this.assertStorageHealthy();
    this.prune();
    const ceremony = this.authenticationCeremonies.get(input.ceremonyId);
    if (!ceremony || ceremony.expiresAtMs <= this.now()) {
      this.authenticationCeremonies.delete(input.ceremonyId);
      throw new Error("Authentication ceremony is unknown or expired");
    }

    const credential = parseAuthenticationCredential(input.credential);
    const credentialId = base64url(
      decodeBase64url(credential.id, "credential id")
    );
    const record = this.passkeys.get(credentialId);
    if (!record || record.revokedAt) {
      throw new Error("Unknown or revoked passkey");
    }
    if (credential.rawId) {
      const rawId = base64url(
        decodeBase64url(credential.rawId, "credential rawId")
      );
      if (rawId !== credentialId) {
        throw new Error("Credential rawId does not match id");
      }
    }

    const clientData = parseClientData(
      credential.response.clientDataJSON,
      "webauthn.get",
      ceremony.challenge,
      this.origins
    );
    const authenticatorData = decodeBase64url(
      credential.response.authenticatorData,
      "authenticatorData"
    );
    const parsed = parseAuthenticatorData(
      authenticatorData,
      this.options.rpId,
      false
    );

    if (credential.response.userHandle) {
      const userHandle = base64url(
        decodeBase64url(credential.response.userHandle, "userHandle")
      );
      if (userHandle !== record.userHandle) {
        throw new Error("Passkey user handle does not match");
      }
    }

    const clientHash = createHash("sha256")
      .update(clientData)
      .digest();
    const signed = Buffer.concat([
      Buffer.from(authenticatorData),
      clientHash
    ]);
    const signature = decodeBase64url(
      credential.response.signature,
      "signature"
    );
    const publicKey = createPublicKey({
      key: Buffer.from(record.publicKeySpki, "base64url"),
      format: "der",
      type: "spki"
    });

    const valid =
      record.algorithm === "Ed25519"
        ? verifySignature(
            null,
            signed,
            publicKey,
            Buffer.from(signature)
          )
        : verifySignature(
            "sha256",
            signed,
            publicKey,
            Buffer.from(signature)
          );
    if (!valid) {
      throw new Error("Passkey signature verification failed");
    }

    if (
      (record.counter > 0 || parsed.counter > 0) &&
      parsed.counter <= record.counter
    ) {
      throw new Error(
        "Passkey signature counter did not advance; possible cloned authenticator"
      );
    }

    record.counter = parsed.counter;
    record.lastUsedAt = new Date(this.now()).toISOString();
    record.updatedAt = record.lastUsedAt;
    this.authenticationCeremonies.delete(ceremony.ceremonyId);
    await this.persist();

    return {
      personId: record.personId,
      ...(record.accountId ? { accountId: record.accountId } : {})
    };
  }

  listForPerson(personIdInput: string): PasskeyRecord[] {
    this.assertStorageHealthy();
    const personId = personIdInput.trim();
    if (!personId) return [];
    return [...this.passkeys.values()]
      .filter(
        (record) =>
          record.personId === personId && !record.revokedAt
      )
      .map((record) => structuredClone(record));
  }

  listForViewer(viewer: HumanViewerIdentity): PasskeyRecord[] {
    return this.listForPerson(viewer.personId).filter(
      (record) => record.accountId === viewer.accountId
    );
  }

  async revokeForViewer(
    credentialIdInput: string,
    viewer: HumanViewerIdentity
  ): Promise<void> {
    this.assertStorageHealthy();
    const credentialId = credentialIdInput.trim();
    const record = this.passkeys.get(credentialId);
    if (
      !record ||
      record.revokedAt ||
      record.personId !== viewer.personId ||
      record.accountId !== viewer.accountId
    ) {
      throw new Error("Passkey is not available to this viewer");
    }

    const active = this.listForViewer(viewer);
    if (active.length <= 1) {
      throw new Error(
        "Cannot revoke the last active passkey; add a backup passkey first"
      );
    }

    const now = new Date(this.now()).toISOString();
    record.revokedAt = now;
    record.updatedAt = now;
    await this.persist();
  }

  async revoke(credentialIdInput: string): Promise<void> {
    this.assertStorageHealthy();
    const credentialId = credentialIdInput.trim();
    const record = this.passkeys.get(credentialId);
    if (!record) {
      throw new Error("Unknown passkey");
    }
    if (!record.revokedAt) {
      const now = new Date(this.now()).toISOString();
      record.revokedAt = now;
      record.updatedAt = now;
      await this.persist();
    }
  }

  private activePasskeysForPerson(personId: string): PasskeyRecord[] {
    return [...this.passkeys.values()].filter(
      (record) =>
        record.personId === personId &&
        !record.revokedAt
    );
  }

  private requireEnrollment(token: string): EnrollmentRecord {
    if (!token.trim()) {
      throw new Error("Enrollment token is required");
    }
    this.prune();
    for (const enrollment of this.enrollments.values()) {
      if (
        Date.parse(enrollment.expiresAt) > this.now() &&
        secureHashEqual(enrollment.tokenHash, token)
      ) {
        return enrollment;
      }
    }
    throw new Error("Enrollment token is invalid or expired");
  }

  private prune(): void {
    const now = this.now();
    for (const [id, enrollment] of this.enrollments) {
      if (Date.parse(enrollment.expiresAt) <= now) {
        this.enrollments.delete(id);
      }
    }
    for (const [id, ceremony] of this.registrationCeremonies) {
      if (ceremony.expiresAtMs <= now) {
        this.registrationCeremonies.delete(id);
      }
    }
    for (const [id, ceremony] of this.authenticationCeremonies) {
      if (ceremony.expiresAtMs <= now) {
        this.authenticationCeremonies.delete(id);
      }
    }
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.options.filePath, "utf8");
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
    const snapshot = SnapshotSchema.parse(JSON.parse(raw) as unknown);
    for (const passkey of snapshot.passkeys) {
      if (this.passkeys.has(passkey.credentialId)) {
        throw new Error("Duplicate passkey credential ID");
      }
      this.passkeys.set(
        passkey.credentialId,
        structuredClone(passkey)
      );
    }
    for (const enrollment of snapshot.enrollments) {
      if (this.enrollments.has(enrollment.enrollmentId)) {
        throw new Error("Duplicate passkey enrollment ID");
      }
      this.enrollments.set(
        enrollment.enrollmentId,
        structuredClone(enrollment)
      );
    }
    this.prune();
  }

  private assertStorageHealthy(): void {
    if (!this.storageFailure) return;
    throw new Error(
      `Passkey storage is unavailable: ${this.storageFailure.message}`
    );
  }

  private persist(): Promise<void> {
    this.assertStorageHealthy();
    const snapshot = {
      version: 1 as const,
      passkeys: [...this.passkeys.values()].map((record) =>
        structuredClone(record)
      ),
      enrollments: [...this.enrollments.values()].map((record) =>
        structuredClone(record)
      )
    };

    this.writeChain = this.writeChain
      .then(async () => {
        await mkdir(dirname(this.options.filePath), { recursive: true });
        const temporary =
          this.options.filePath + "." + process.pid.toString() + ".tmp";
        await writeFile(
          temporary,
          JSON.stringify(snapshot, null, 2) + "\n",
          { encoding: "utf8", mode: 0o600 }
        );
        await rename(temporary, this.options.filePath);
      })
      .catch((error: unknown) => {
        this.storageFailure =
          error instanceof Error
            ? error
            : new Error("Unknown passkey persistence failure");
        throw this.storageFailure;
      });
    return this.writeChain;
  }
}
