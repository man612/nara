import { describe, expect, it } from "vitest";
import {
  openPrivateJson,
  privateDataKeyringFromEnvironment,
  sealPrivateJson
} from "../src/security/private-data.js";

function encoded(byte: number): string {
  return Buffer.from(
    Uint8Array.from({ length: 32 }, () => byte)
  ).toString("base64url");
}

describe("private-data keyring", () => {
  it("parses an active keyring and authenticates AES-GCM envelopes", () => {
    const keyring = privateDataKeyringFromEnvironment({
      NARA_PRIVATE_DATA_ACTIVE_KEY_ID: "current",
      NARA_PRIVATE_DATA_KEYS_JSON: JSON.stringify({
        current: encoded(1),
        previous: encoded(2)
      })
    });
    expect(keyring?.activeKeyId).toBe("current");

    const envelope = sealPrivateJson(
      { secret: "value" },
      keyring!,
      "test-purpose"
    );
    expect(
      openPrivateJson(envelope, keyring!, "test-purpose").value
    ).toEqual({ secret: "value" });

    expect(() =>
      openPrivateJson(envelope, keyring!, "wrong-purpose")
    ).toThrow(/authentication or decryption/);
  });

  it("rejects incomplete and wrong-length keyrings", () => {
    expect(() =>
      privateDataKeyringFromEnvironment({
        NARA_PRIVATE_DATA_ACTIVE_KEY_ID: "current"
      })
    ).toThrow(/configured together/);

    expect(() =>
      privateDataKeyringFromEnvironment({
        NARA_PRIVATE_DATA_ACTIVE_KEY_ID: "current",
        NARA_PRIVATE_DATA_KEYS_JSON: JSON.stringify({
          current: Buffer.from("short").toString("base64url")
        })
      })
    ).toThrow(/32 bytes/);
  });
});
