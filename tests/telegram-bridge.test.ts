import { describe, expect, it, vi } from "vitest";
import { FirmwareVoiceControlRegistry } from "../src/device/voice-control.js";
import { TelegramBridge } from "../src/telegram/bridge.js";

describe("TelegramBridge", () => {
  it("ignores unauthorized users and routes allowlisted ask text", async () => {
    const registry = new FirmwareVoiceControlRegistry();
    const sendText = vi.fn(async () => {});
    registry.register(
      {
        sessionId: "s1",
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
      {
        sendText,
        async executeTool(call) {
          return { name: call.name, ok: true };
        },
        async interrupt() {}
      }
    );

    const responses: Array<{ method: string; body: Record<string, unknown> }> = [];
    let poll = 0;
    const bridge = new TelegramBridge({
      botToken: "bot-token",
      allowedUserIds: [123],
      voiceControls: registry,
      targetDeviceId: "device-1",
      fetchImpl: (async (input, init) => {
        const method = String(input).split("/").pop()!;
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        responses.push({ method, body });

        if (method === "getUpdates") {
          poll += 1;
          return new Response(
            JSON.stringify({
              ok: true,
              result:
                poll === 1
                  ? [
                      {
                        update_id: 1,
                        message: {
                          message_id: 1,
                          text: "ignore me",
                          from: { id: 999 },
                          chat: { id: 10 }
                        }
                      },
                      {
                        update_id: 2,
                        message: {
                          message_id: 2,
                          text: "/ask halo Nara",
                          from: { id: 123 },
                          chat: { id: 20 }
                        }
                      }
                    ]
                  : []
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        return new Response(JSON.stringify({ ok: true, result: {} }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }) as typeof fetch
    });

    await bridge.pollOnce();
    expect(sendText).toHaveBeenCalledWith("halo Nara");

    await bridge.handleOutputTranscript("Halo dari Nara", true);
    expect(
      responses.some(
        (entry) =>
          entry.method === "sendMessage" &&
          entry.body.chat_id === 20 &&
          entry.body.text === "Halo dari Nara"
      )
    ).toBe(true);
  });

  it("uses local device_notify for /notify without voice text injection", async () => {
    const registry = new FirmwareVoiceControlRegistry();
    const executeTool = vi.fn(async (call) => ({
      name: call.name,
      ok: true
    }));
    const sendText = vi.fn(async () => {});
    registry.register(
      {
        sessionId: "s1",
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
      { sendText, executeTool, async interrupt() {} }
    );

    let delivered = false;
    const bridge = new TelegramBridge({
      botToken: "bot-token",
      allowedUserIds: [123],
      voiceControls: registry,
      targetDeviceId: "device-1",
      fetchImpl: (async (input, init) => {
        const method = String(input).split("/").pop()!;
        if (method === "getUpdates") {
          return new Response(
            JSON.stringify({
              ok: true,
              result: delivered
                ? []
                : [
                    {
                      update_id: 1,
                      message: {
                        message_id: 1,
                        text: "/notify jangan lupa makan",
                        from: { id: 123 },
                        chat: { id: 20 }
                      }
                    }
                  ]
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        delivered = true;
        return new Response(JSON.stringify({ ok: true, result: {} }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }) as typeof fetch
    });

    await bridge.pollOnce();
    expect(executeTool).toHaveBeenCalledWith({
      name: "device_companion",
      arguments: {
        op: "notify",
        text: "jangan lupa makan",
        emotion: "happy",
        sound: "builtin:popup"
      },
      callId: expect.stringMatching(/^telegram-notify-/)
    });
    expect(sendText).not.toHaveBeenCalled();
  });
});
