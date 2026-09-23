import {
  createCipheriv,
  createDecipheriv,
  randomBytes
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const ENVELOPE_ALGORITHM = "A256GCM";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export type PrivateDataKeyring = {
  activeKeyId: string;
  keys: ReadonlyMap<string, Uint8Array>;
};

export type EncryptedPrivateDataEnvelope = {
  version: 1;
  encryption: {
    algorithm: "A256GCM";
    keyId: string;
    iv: string;
    tag: string;
  };
  ciphertext: string;
};

function aadFor(purpose: string): Buffer {
  const normalized = purpose.trim();
  if (!normalized) {
    throw new Error("Private-data encryption purpose is required");
  }
  return Buffer.from(
    `nara-private-data:${normalized}:v1`,
    "utf8"
  );
}

function requireKey(
  keyring: PrivateDataKeyring,
  keyId: string
): Uint8Array {
  const key = keyring.keys.get(keyId);
  if (!key) {
    throw new Error(
      `Private-data key is unavailable: ${keyId}`
    );
  }
  if (key.byteLength !== KEY_BYTES) {
    throw new Error(
      `Private-data key ${keyId} must be 32 bytes`
    );
  }
  return key;
}

export function isEncryptedPrivateDataEnvelope(
  value: unknown
): value is EncryptedPrivateDataEnvelope {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const encryption = record.encryption;
  return (
    record.version === 1 &&
    typeof record.ciphertext === "string" &&
    encryption !== null &&
    typeof encryption === "object" &&
    !Array.isArray(encryption) &&
    (encryption as Record<string, unknown>).algorithm ===
      ENVELOPE_ALGORITHM &&
    typeof (encryption as Record<string, unknown>).keyId ===
      "string" &&
    typeof (encryption as Record<string, unknown>).iv ===
      "string" &&
    typeof (encryption as Record<string, unknown>).tag ===
      "string"
  );
}

export function sealPrivateJson(
  value: unknown,
  keyring: PrivateDataKeyring,
  purpose: string
): EncryptedPrivateDataEnvelope {
  const keyId = keyring.activeKeyId.trim();
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new Error("Private-data active key ID is invalid");
  }
  const key = requireKey(keyring, keyId);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(
    ALGORITHM,
    Buffer.from(key),
    iv,
    { authTagLength: TAG_BYTES }
  );
  cipher.setAAD(aadFor(purpose));
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();

  return {
    version: 1,
    encryption: {
      algorithm: ENVELOPE_ALGORITHM,
      keyId,
      iv: iv.toString("base64url"),
      tag: tag.toString("base64url")
    },
    ciphertext: ciphertext.toString("base64url")
  };
}

export function openPrivateJson(
  envelope: EncryptedPrivateDataEnvelope,
  keyring: PrivateDataKeyring,
  purpose: string
): { value: unknown; keyId: string } {
  const keyId = envelope.encryption.keyId;
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new Error("Encrypted private-data key ID is invalid");
  }
  const key = requireKey(keyring, keyId);
  const iv = Buffer.from(envelope.encryption.iv, "base64url");
  const tag = Buffer.from(envelope.encryption.tag, "base64url");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64url");
  if (iv.byteLength !== IV_BYTES) {
    throw new Error("Encrypted private-data IV is invalid");
  }
  if (tag.byteLength !== TAG_BYTES) {
    throw new Error("Encrypted private-data auth tag is invalid");
  }

  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      Buffer.from(key),
      iv,
      { authTagLength: TAG_BYTES }
    );
    decipher.setAAD(aadFor(purpose));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);
    return {
      value: JSON.parse(plaintext.toString("utf8")) as unknown,
      keyId
    };
  } catch {
    throw new Error(
      "Encrypted private data failed authentication or decryption"
    );
  }
}

export function privateDataKeyringFromEnvironment(
  env: NodeJS.ProcessEnv
): PrivateDataKeyring | undefined {
  const rawKeys = env.NARA_PRIVATE_DATA_KEYS_JSON?.trim();
  const activeKeyId =
    env.NARA_PRIVATE_DATA_ACTIVE_KEY_ID?.trim();

  if (!rawKeys && !activeKeyId) return undefined;
  if (!rawKeys || !activeKeyId) {
    throw new Error(
      "NARA_PRIVATE_DATA_KEYS_JSON and " +
        "NARA_PRIVATE_DATA_ACTIVE_KEY_ID must be configured together"
    );
  }
  if (!KEY_ID_PATTERN.test(activeKeyId)) {
    throw new Error(
      "NARA_PRIVATE_DATA_ACTIVE_KEY_ID is invalid"
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawKeys) as unknown;
  } catch {
    throw new Error(
      "NARA_PRIVATE_DATA_KEYS_JSON must be a JSON object"
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new Error(
      "NARA_PRIVATE_DATA_KEYS_JSON must be a JSON object"
    );
  }

  const keys = new Map<string, Uint8Array>();
  for (const [keyId, encoded] of Object.entries(parsed)) {
    if (
      !KEY_ID_PATTERN.test(keyId) ||
      typeof encoded !== "string" ||
      !BASE64URL_PATTERN.test(encoded)
    ) {
      throw new Error(
        `Invalid private-data key entry: ${keyId}`
      );
    }
    const key = Buffer.from(encoded, "base64url");
    if (key.byteLength !== KEY_BYTES) {
      throw new Error(
        `Private-data key ${keyId} must decode to 32 bytes`
      );
    }
    keys.set(keyId, Uint8Array.from(key));
  }

  if (!keys.has(activeKeyId)) {
    throw new Error(
      "Active private-data key ID is not present in the keyring"
    );
  }

  return { activeKeyId, keys };
}
