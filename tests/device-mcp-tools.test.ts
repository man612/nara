import { describe, expect, it } from "vitest";
import { DeviceMcpToolProvider } from "../src/device/mcp-tools.js";
import type { FirmwareSessionTransport } from "../src/gateway.js";

function createTransport() {
  const sent: unknown[] = [];
  const transport: FirmwareSessionTransport = {
    playback: {
      format: "opus",
      sample_rate: 24000,
      channels: 1,
      frame_duration: 60
    },
    sendJson(message) {
      sent.push(message);
    },
    sendAudio() {},
    close() {}
  };
  return { sent, transport };
}

function payloadAt(sent: unknown[], index: number) {
  return (sent[index] as { payload: Record<string, unknown> }).payload;
}

describe("DeviceMcpToolProvider", () => {
  it("exposes compact Nara aliases and validates arguments before touching the device", async () => {
    const { sent, transport } = createTransport();
    const provider = new DeviceMcpToolProvider(transport);

    await expect(provider.listTools()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "device_get_status", effect: "read" }),
        expect.objectContaining({ name: "device_set_volume", effect: "write" })
      ])
    );

    await expect(
      provider.callTool(
        {
          name: "device_set_volume",
          arguments: { volume: 101 },
          callId: "bad"
        },
        new AbortController().signal
      )
    ).resolves.toMatchObject({
      ok: false,
      error: "volume must be an integer from 0 to 100"
    });
    expect(sent).toHaveLength(0);
  });

  it("negotiates legacy MCP, discovers the target, calls it, and compacts the result", async () => {
    const { sent, transport } = createTransport();
    const provider = new DeviceMcpToolProvider(transport);
    const pending = provider.callTool(
      {
        name: "device_set_volume",
        arguments: { volume: 30 },
        callId: "volume-1"
      },
      new AbortController().signal
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(payloadAt(sent, 0)).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize"
    });

    provider.onEvent({
      type: "mcp",
      payload: {
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "waveshare", version: "test" }
        }
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(payloadAt(sent, 1)).toEqual({
      jsonrpc: "2.0",
      method: "notifications/initialized"
    });
    expect(payloadAt(sent, 2)).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list"
    });

    provider.onEvent({
      type: "mcp",
      payload: {
        jsonrpc: "2.0",
        id: 2,
        result: {
          tools: [
            {
              name: "self.get_device_status",
              description: "status",
              inputSchema: { type: "object" }
            },
            {
              name: "self.audio_speaker.set_volume",
              description: "volume",
              inputSchema: { type: "object" }
            }
          ]
        }
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(payloadAt(sent, 3)).toEqual({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "self.audio_speaker.set_volume",
        arguments: { volume: 30 }
      }
    });

    provider.onEvent({
      type: "mcp",
      payload: {
        jsonrpc: "2.0",
        id: 3,
        result: {
          content: [{ type: "text", text: "true" }],
          isError: false
        }
      }
    });

    await expect(pending).resolves.toEqual({
      name: "device_set_volume",
      callId: "volume-1",
      ok: true,
      value: true
    });
  });
});
