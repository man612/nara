import { describe, expect, it } from "vitest";
import { validatePasskeyDeploymentSecurity } from "../src/config/deployment-security.js";

describe("production deployment security", () => {
  it("accepts HTTPS production passkey origins", () => {
    expect(() =>
      validatePasskeyDeploymentSecurity({
        production: true,
        rpId: "nara.example",
        origins: ["https://nara.example"]
      })
    ).not.toThrow();
  });

  it("rejects localhost and HTTP passkey production settings", () => {
    expect(() =>
      validatePasskeyDeploymentSecurity({
        production: true,
        rpId: "localhost",
        origins: ["http://localhost:8787"]
      })
    ).toThrow(/RP ID/);

    expect(() =>
      validatePasskeyDeploymentSecurity({
        production: true,
        rpId: "nara.example",
        origins: ["http://nara.example"]
      })
    ).toThrow(/HTTPS/);
  });

  it("keeps localhost available for non-production development", () => {
    expect(() =>
      validatePasskeyDeploymentSecurity({
        production: false,
        rpId: "localhost",
        origins: ["http://localhost:8787"]
      })
    ).not.toThrow();
  });
});
