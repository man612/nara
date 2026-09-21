import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign
} from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PasskeyRegistry } from "../src/identity/passkeys.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function uintHeader(major: number, value: number): Uint8Array {
  if (value < 24) return Uint8Array.of((major << 5) | value);
  if (value <= 0xff) {
    return Uint8Array.of((major << 5) | 24, value);
  }
  if (value <= 0xffff) {
    return Uint8Array.of(
      (major << 5) | 25,
      (value >>> 8) & 0xff,
      value & 0xff
    );
  }
  return Uint8Array.of(
    (major << 5) | 26,
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff
  );
}

function concat(parts: Uint8Array[]): Uint8Array {
  return new Uint8Array(
    Buffer.concat(parts.map((part) => Buffer.from(part)))
  );
}

function cbor(value: unknown): Uint8Array {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value >= 0
      ? uintHeader(0, value)
      : uintHeader(1, -1 - value);
  }
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return concat([uintHeader(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) {
    return concat([uintHeader(2, value.length), value]);
  }
  if (value instanceof Map) {
    const parts: Uint8Array[] = [
      uintHeader(5, value.size)
    ];
    for (const [key, item] of value) {
      parts.push(cbor(key), cbor(item));
    }
    return concat(parts);
  }
  throw new Error("unsupported test CBOR value");
}

function counterBytes(value: number): Uint8Array {
  return Uint8Array.of(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff
  );
}

function clientData(input: {
  type: "webauthn.create" | "webauthn.get";
  challenge: string;
  origin: string;
}): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      type: input.type,
      challenge: input.challenge,
      origin: input.origin,
      crossOrigin: false
    })
  );
}

function authData(input: {
  rpId: string;
  flags: number;
  counter: number;
  credentialId?: Uint8Array;
  coseKey?: Uint8Array;
}): Uint8Array {
  const base = concat([
    createHash("sha256").update(input.rpId).digest(),
    Uint8Array.of(input.flags),
    counterBytes(input.counter)
  ]);
  if (!input.credentialId || !input.coseKey) return base;

  const length = input.credentialId.length;
  return concat([
    base,
    new Uint8Array(16),
    Uint8Array.of((length >>> 8) & 0xff, length & 0xff),
    input.credentialId,
    input.coseKey
  ]);
}

async function registryFixture() {
  const directory = await mkdtemp(join(tmpdir(), "nara-passkeys-"));
  tempDirs.push(directory);
  const filePath = join(directory, "passkeys.json");
  const registry = await PasskeyRegistry.open({
    filePath,
    rpId: "nara.example",
    rpName: "Nara",
    origins: ["https://nara.example"]
  });
  return { registry, filePath };
}

describe("PasskeyRegistry", () => {
  it("registers and authenticates a user-verified ES256 discoverable credential", async () => {
    const { registry, filePath } = await registryFixture();
    const enrollment = await registry.issueEnrollment({
      personId: "person:partner",
      accountId: "account:partner"
    });
    const registration = registry.createRegistrationOptions({
      enrollmentToken: enrollment.enrollmentToken,
      displayName: "Partner"
    });

    const { publicKey, privateKey } = generateKeyPairSync("ec", {
      namedCurve: "P-256"
    });
    const jwk = publicKey.export({ format: "jwk" });
    if (!jwk.x || !jwk.y) throw new Error("missing test JWK point");

    const credentialId = randomBytes(32);
    const cose = cbor(
      new Map<unknown, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x, "base64url")],
        [-3, Buffer.from(jwk.y, "base64url")]
      ])
    );
    const registrationAuthData = authData({
      rpId: "nara.example",
      flags: 0x45,
      counter: 0,
      credentialId,
      coseKey: cose
    });
    const attestationObject = cbor(
      new Map<unknown, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", registrationAuthData]
      ])
    );
    const createClient = clientData({
      type: "webauthn.create",
      challenge: registration.publicKey.challenge,
      origin: "https://nara.example"
    });

    const stored = await registry.verifyRegistration({
      ceremonyId: registration.ceremonyId,
      enrollmentToken: enrollment.enrollmentToken,
      credential: {
        id: b64(credentialId),
        rawId: b64(credentialId),
        type: "public-key",
        response: {
          clientDataJSON: b64(createClient),
          attestationObject: b64(attestationObject),
          transports: ["internal", "hybrid"]
        }
      }
    });

    expect(stored).toMatchObject({
      personId: "person:partner",
      accountId: "account:partner",
      algorithm: "ES256",
      counter: 0,
      transports: ["internal", "hybrid"]
    });

    const snapshot = await readFile(filePath, "utf8");
    expect(snapshot).not.toContain(enrollment.enrollmentToken);
    expect(snapshot).not.toContain(privateKey.export({
      format: "pem",
      type: "pkcs8"
    }).toString());

    const authentication =
      registry.createAuthenticationOptions();
    const getClient = clientData({
      type: "webauthn.get",
      challenge: authentication.publicKey.challenge,
      origin: "https://nara.example"
    });
    const getAuthData = authData({
      rpId: "nara.example",
      flags: 0x05,
      counter: 1
    });
    const signed = Buffer.concat([
      Buffer.from(getAuthData),
      createHash("sha256").update(getClient).digest()
    ]);
    const signature = sign("sha256", signed, privateKey);

    await expect(
      registry.verifyAuthentication({
        ceremonyId: authentication.ceremonyId,
        credential: {
          id: b64(credentialId),
          rawId: b64(credentialId),
          type: "public-key",
          response: {
            clientDataJSON: b64(getClient),
            authenticatorData: b64(getAuthData),
            signature: b64(signature),
            userHandle: stored.userHandle
          }
        }
      })
    ).resolves.toEqual({
      personId: "person:partner",
      accountId: "account:partner"
    });

    const replayCeremony =
      registry.createAuthenticationOptions();
    const replayClient = clientData({
      type: "webauthn.get",
      challenge: replayCeremony.publicKey.challenge,
      origin: "https://nara.example"
    });
    const replaySigned = Buffer.concat([
      Buffer.from(getAuthData),
      createHash("sha256").update(replayClient).digest()
    ]);
    const replaySignature = sign(
      "sha256",
      replaySigned,
      privateKey
    );

    await expect(
      registry.verifyAuthentication({
        ceremonyId: replayCeremony.ceremonyId,
        credential: {
          id: b64(credentialId),
          type: "public-key",
          response: {
            clientDataJSON: b64(replayClient),
            authenticatorData: b64(getAuthData),
            signature: b64(replaySignature),
            userHandle: stored.userHandle
          }
        }
      })
    ).rejects.toThrow(/counter did not advance/);
  });

  it("fails closed on wrong origin and consumes no enrollment", async () => {
    const { registry } = await registryFixture();
    const enrollment = await registry.issueEnrollment({
      personId: "person:partner"
    });
    const registration = registry.createRegistrationOptions({
      enrollmentToken: enrollment.enrollmentToken,
      displayName: "Partner"
    });

    const { publicKey } = generateKeyPairSync("ec", {
      namedCurve: "P-256"
    });
    const jwk = publicKey.export({ format: "jwk" });
    if (!jwk.x || !jwk.y) throw new Error("missing test JWK point");
    const credentialId = randomBytes(32);
    const cose = cbor(
      new Map<unknown, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x, "base64url")],
        [-3, Buffer.from(jwk.y, "base64url")]
      ])
    );
    const registrationAuthData = authData({
      rpId: "nara.example",
      flags: 0x45,
      counter: 0,
      credentialId,
      coseKey: cose
    });
    const attestationObject = cbor(
      new Map<unknown, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", registrationAuthData]
      ])
    );

    await expect(
      registry.verifyRegistration({
        ceremonyId: registration.ceremonyId,
        enrollmentToken: enrollment.enrollmentToken,
        credential: {
          id: b64(credentialId),
          type: "public-key",
          response: {
            clientDataJSON: b64(
              clientData({
                type: "webauthn.create",
                challenge: registration.publicKey.challenge,
                origin: "https://evil.example"
              })
            ),
            attestationObject: b64(attestationObject)
          }
        }
      })
    ).rejects.toThrow(/origin is not allowed/);

    expect(
      registry.getEnrollmentIdentity(
        enrollment.enrollmentToken
      )
    ).toEqual({ personId: "person:partner" });
  });
});
