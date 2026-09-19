import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { RawData } from "ws";
import {
  createGatewayServer,
  type FirmwareSessionInfo
} from "../src/gateway.js";
import {
  encodeFirmwareAudioFrame,
  type FirmwareAudioFrame
} from "../src/device/firmware-wire.js";

function waitForMessage(socket: WebSocket): Promise<{ data: RawData; isBinary: boolean }> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data, isBinary) => resolve({ data, isBinary }));
    socket.once("error", reject);
  });
}

async function closeGateway(
  socket: WebSocket,
  server: ReturnType<typeof createGatewayServer>["server"],
  wss: ReturnType<typeof createGatewayServer>["wss"]
) {
  if (socket.readyState === WebSocket.OPEN) {
    const closed = once(socket, "close");
    socket.close();
    await closed;
  } else if (socket.readyState === WebSocket.CONNECTING) {
    socket.terminate();
  }

  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}

describe("firmware WebSocket edge", () => {
  it("completes hello and delivers framed Opus to the gateway hook", async () => {
    let resolveAudio!: (value: {
      session: FirmwareSessionInfo;
      frame: FirmwareAudioFrame;
    }) => void;
    const audioReceived = new Promise<{
      session: FirmwareSessionInfo;
      frame: FirmwareAudioFrame;
    }>((resolve) => {
      resolveAudio = resolve;
    });

    const gateway = createGatewayServer({
      hooks: {
        onFirmwareAudio: (session, frame) => resolveAudio({ session, frame })
      }
    });

    await new Promise<void>((resolve) =>
      gateway.server.listen(0, "127.0.0.1", resolve)
    );
    const address = gateway.server.address() as AddressInfo;
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/device`);

    try {
      await once(socket, "open");

      socket.send(
        JSON.stringify({
          type: "hello",
          version: 2,
          transport: "websocket",
          features: { mcp: true },
          audio_params: {
            format: "opus",
            sample_rate: 16000,
            channels: 1,
            frame_duration: 60
          }
        })
      );

      const helloMessage = await waitForMessage(socket);
      expect(helloMessage.isBinary).toBe(false);
      const serverHello = JSON.parse(helloMessage.data.toString());
      expect(serverHello).toMatchObject({
        type: "hello",
        transport: "websocket",
        audio_params: {
          format: "opus",
          sample_rate: 16000,
          channels: 1,
          frame_duration: 60
        }
      });
      expect(serverHello.session_id).toEqual(expect.any(String));

      const payload = Uint8Array.from([0xf8, 0xff, 0xfe, 0x11, 0x22]);
      const timestamp = 0x10203040;
      socket.send(
        Buffer.from(encodeFirmwareAudioFrame(payload, 2, timestamp)),
        { binary: true }
      );

      const observed = await audioReceived;
      expect(observed.session.sessionId).toBe(serverHello.session_id);
      expect(observed.session.protocolVersion).toBe(2);
      expect(observed.frame.timestamp).toBe(timestamp);
      expect(Array.from(observed.frame.payload)).toEqual(Array.from(payload));
    } finally {
      await closeGateway(socket, gateway.server, gateway.wss);
    }
  });

  it("rejects binary audio before the firmware hello", async () => {
    const gateway = createGatewayServer();

    await new Promise<void>((resolve) =>
      gateway.server.listen(0, "127.0.0.1", resolve)
    );
    const address = gateway.server.address() as AddressInfo;
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/device`);

    try {
      await once(socket, "open");
      socket.send(Buffer.from([1, 2, 3]), { binary: true });

      const [code] = (await once(socket, "close")) as [number, Buffer];
      expect(code).toBe(1002);
    } finally {
      await new Promise<void>((resolve) => gateway.wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        gateway.server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});
