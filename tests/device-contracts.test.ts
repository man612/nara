import { describe, expect, it } from "vitest";
import type {
  DeviceCommand,
  Emotion,
  Interaction
} from "../src/contracts/device.js";

describe("device face contract", () => {
  it("keeps interaction and emotion independent", () => {
    const interaction: Interaction = "thinking";
    const emotion: Emotion = "shy";

    const command: DeviceCommand = {
      type: "face.set",
      interaction,
      emotion,
      intensity: 0.8
    };

    expect(command).toMatchObject({
      type: "face.set",
      interaction: "thinking",
      emotion: "shy",
      intensity: 0.8
    });
  });

  it("allows an interaction-only face update", () => {
    const command: DeviceCommand = {
      type: "face.set",
      interaction: "listening"
    };

    expect(command).toEqual({
      type: "face.set",
      interaction: "listening"
    });
  });

  it("keeps thinking out of the emotion vocabulary", () => {
    // @ts-expect-error thinking is an interaction state, not an emotion
    const invalidEmotion: Emotion = "thinking";
    expect(invalidEmotion).toBe("thinking");
  });
});
