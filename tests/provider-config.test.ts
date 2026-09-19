import { describe, expect, it } from "vitest";
import { interpolateEnvironment } from "../src/config/providers.js";

describe("provider config environment interpolation", () => {
  it("uses an environment value when present", () => {
    process.env.COMPANION_TEST_MODEL = "custom-model";
    expect(interpolateEnvironment("model: ${COMPANION_TEST_MODEL:-fallback}")).toBe(
      "model: custom-model"
    );
    delete process.env.COMPANION_TEST_MODEL;
  });

  it("uses the configured fallback when missing", () => {
    delete process.env.COMPANION_MISSING_MODEL;
    expect(interpolateEnvironment("model: ${COMPANION_MISSING_MODEL:-fallback}")).toBe(
      "model: fallback"
    );
  });
});
