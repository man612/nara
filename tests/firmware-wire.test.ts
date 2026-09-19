import { describe, expect, it } from "vitest";
import {
  createFirmwareServerHello,
  decodeFirmwareAudioFrame,
  encodeFirmwareAudioFrame,
  isDeviceAuthorized,
  isFirmwareHello
} from "../src/device/firmware-wire.js";

describe("firmware wire protocol", () => {
  it("recognizes the hello emitted by Nara firmware", () => {
    expect(
      isFirmwareHello({
        type: "hello",
        version: 1,
        transport: "websocket",
        features: { mcp: true },
        audio_params: {
          format: "opus",
          sample_rate: 16000,
          channels: 1,
          frame_duration: 60
        }
      })
    ).toBe(true);

    expect(
      isFirmwareHello({
        type: "hello",
        deviceId: "virtual-1"
      })
    ).toBe(false);
  });

  it("creates the server hello shape the firmware waits for", () => {
    expect(createFirmwareServerHello("session-123")).toEqual({
      type: "hello",
      transport: "websocket",
      session_id: "session-123",
      audio_params: {
        format: "opus",
        sample_rate: 16000,
        channels: 1,
        frame_duration: 60
      }
    });
  });

  it.each([1, 2, 3] as const)("round-trips Opus payloads for protocol v%s", (version) => {
    const payload = Uint8Array.from([0xf8, 0xff, 0xfe, 0x01, 0x02, 0x03]);
    const timestamp = 0x12345678;

    const encoded = encodeFirmwareAudioFrame(payload, version, timestamp);
    const decoded = decodeFirmwareAudioFrame(encoded, version);

    expect(Array.from(decoded.payload)).toEqual(Array.from(payload));
    expect(decoded.timestamp).toBe(version === 2 ? timestamp : 0);
  });

  it("rejects malformed framed payload lengths", () => {
    const valid = encodeFirmwareAudioFrame(Uint8Array.from([1, 2, 3]), 3);
    const malformed = valid.slice();
    new DataView(malformed.buffer).setUint16(2, 99, false);

    expect(() => decodeFirmwareAudioFrame(malformed, 3)).toThrow(/length mismatch/);
  });

  it("requires the configured bearer token but stays open in tokenless dev mode", () => {
    expect(isDeviceAuthorized(undefined, undefined)).toBe(true);
    expect(isDeviceAuthorized("Bearer secret", "secret")).toBe(true);
    expect(isDeviceAuthorized("Bearer wrong", "secret")).toBe(false);
    expect(isDeviceAuthorized(undefined, "secret")).toBe(false);
  });
});
