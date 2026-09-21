import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  createGatewayServer,
  type PhoneSessionTransport
} from "../src/gateway.js";
import { encodePhonePcmFrame } from "../src/phone/protocol.js";

function phoneProtocols(token: string, viewerSession?: string): string[] {
  return [
    "nara-phone-v1",
    "auth." + Buffer.from(token, "utf8").toString("base64url"),
    ...(viewerSession ? ["viewer." + viewerSession] : [])
  ];
}

describe("authenticated phone audio gateway", () => {
  it("accepts the phone token, forwards PCM, and returns framed audio", async () => {
    let receivedSamples = 0;
    let transportRef: PhoneSessionTransport | undefined;

    const gateway = createGatewayServer({
      deviceToken: "device-secret",
      phoneToken: "phone-secret",
      phoneSessionFactory: async (transport) => {
        transportRef = transport;
        return {
          async onAudio(chunk) {
            receivedSamples += chunk.data.byteLength / 2;
            transport.sendAudio({
              format: "pcm16le",
              data: chunk.data.slice(),
              sampleRate: 16000,
              channels: 1
            });
          },
          async onEvent() {},
          async close() {}
        };
      }
    });
    await new Promise<void>((resolve) =>
      gateway.server.listen(0, "127.0.0.1", resolve)
    );

    const port = (gateway.server.address() as AddressInfo).port;
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/device`,
      phoneProtocols("phone-secret")
    );

    try {
      await once(socket, "open");
      const ready = new Promise<Record<string, unknown>>((resolve) => {
        socket.once("message", (data) => resolve(JSON.parse(data.toString())));
      });
      socket.send(JSON.stringify({ type: "phone.hello", version: 1 }));
      await expect(ready).resolves.toMatchObject({
        type: "phone.ready",
        version: 1
      });
      expect(transportRef).toBeDefined();

      const returned = new Promise<Buffer>((resolve) => {
        socket.once("message", (data, isBinary) => {
          expect(isBinary).toBe(true);
          resolve(data as Buffer);
        });
      });
      socket.send(
        Buffer.from(
          encodePhonePcmFrame({
            format: "pcm16le",
            data: new Uint8Array(1920),
            sampleRate: 16000,
            channels: 1
          })
        )
      );

      const frame = await returned;
      expect(frame.subarray(0, 4).toString()).toBe("NP16");
      expect(receivedSamples).toBe(960);
    } finally {
      if (socket.readyState === WebSocket.OPEN) socket.close();
      await new Promise<void>((resolve) => gateway.wss.close(() => resolve()));
      await new Promise<void>((resolve) => gateway.server.close(() => resolve()));
    }
  });

  it("binds only a resolved short-lived human viewer session to the phone factory", async () => {
    let viewerId: string | undefined;
    const gateway = createGatewayServer({
      phoneToken: "phone-secret",
      resolvePhoneViewerSession: (sessionToken) =>
        sessionToken === "valid-session"
          ? { viewerId: "person:partner", accountId: "account:partner" }
          : undefined,
      phoneSessionFactory: async (_transport, context) => {
        viewerId = context.viewerId;
        return {
          async onAudio() {},
          async onEvent() {},
          async close() {}
        };
      }
    });
    await new Promise<void>((resolve) =>
      gateway.server.listen(0, "127.0.0.1", resolve)
    );
    const port = (gateway.server.address() as AddressInfo).port;
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/device`,
      phoneProtocols("phone-secret", "valid-session")
    );

    try {
      await once(socket, "open");
      const ready = new Promise<Record<string, unknown>>((resolve) => {
        socket.once("message", (data) => resolve(JSON.parse(data.toString())));
      });
      socket.send(JSON.stringify({ type: "phone.hello", version: 1 }));
      await expect(ready).resolves.toMatchObject({ type: "phone.ready" });
      expect(viewerId).toBe("person:partner");
    } finally {
      if (socket.readyState === WebSocket.OPEN) socket.close();
      await new Promise<void>((resolve) => gateway.wss.close(() => resolve()));
      await new Promise<void>((resolve) => gateway.server.close(() => resolve()));
    }
  });

  it("does not let phone-only authorization impersonate firmware", async () => {
    const gateway = createGatewayServer({
      deviceToken: "device-secret",
      phoneToken: "phone-secret",
      phoneSessionFactory: async () => ({
        async onAudio() {},
        async onEvent() {},
        async close() {}
      })
    });
    await new Promise<void>((resolve) =>
      gateway.server.listen(0, "127.0.0.1", resolve)
    );
    const port = (gateway.server.address() as AddressInfo).port;
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/device`,
      phoneProtocols("phone-secret")
    );

    try {
      await once(socket, "open");
      const closed = once(socket, "close");
      socket.send(
        JSON.stringify({
          type: "hello",
          version: 2,
          transport: "websocket",
          audio_params: {
            format: "opus",
            sample_rate: 16000,
            channels: 1,
            frame_duration: 60
          }
        })
      );
      const [code] = await closed;
      expect(code).toBe(1008);
    } finally {
      if (socket.readyState === WebSocket.OPEN) socket.close();
      await new Promise<void>((resolve) => gateway.wss.close(() => resolve()));
      await new Promise<void>((resolve) => gateway.server.close(() => resolve()));
    }
  });
});
