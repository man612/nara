import { describe, expect, it } from "vitest";
import { interpolateEnvironment } from "../src/config/providers.js";

describe("provider config environment interpolation", () => {
  it("uses an environment value when present", () => {
    process.env.NARA_TEST_MODEL = "custom-model";
    expect(interpolateEnvironment("model: ${NARA_TEST_MODEL:-fallback}")).toBe(
      "model: custom-model"
    );
    delete process.env.NARA_TEST_MODEL;
  });

  it("uses the configured fallback when missing", () => {
    delete process.env.NARA_MISSING_MODEL;
    expect(interpolateEnvironment("model: ${NARA_MISSING_MODEL:-fallback}")).toBe(
      "model: fallback"
    );
  });
});
