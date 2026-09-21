import { describe, expect, it, vi } from "vitest";
import { FirmwareVoiceControlRegistry } from "../src/device/voice-control.js";

describe("FirmwareVoiceControlRegistry", () => {
  it("routes remote text/actions to a selected device", async () => {
    const registry = new FirmwareVoiceControlRegistry();
    const sendText = vi.fn(async () => {});
    const executeTool = vi.fn(async (call) => ({
      name: call.name,
      ok: true,
      value: "ok"
    }));
    const interrupt = vi.fn(async () => {});

    registry.register(
      {
        sessionId: "session-1",
        protocolVersion: 2,
        hello: {
          type: "hello",
          version: 2,
          transport: "websocket",
          audio_params: {
            format: "opus",
            sample_rate: 16000,
            channels: 1,
            frame_duration: 60
          }
        },
        deviceId: "device-1"
      },
      { sendText, executeTool, interrupt }
    );

    await expect(
      registry.sendText("hello", "device-1")
    ).resolves.toBe(true);
    await expect(
      registry.executeTool(
        { name: "device_get_status", arguments: {} },
        "device-1"
      )
    ).resolves.toMatchObject({ ok: true });
    expect(sendText).toHaveBeenCalledWith("hello");

    registry.unregister("session-1");
    await expect(
      registry.sendText("offline", "device-1")
    ).resolves.toBe(false);
  });
});
