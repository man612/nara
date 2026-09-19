import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { WebSocketServer } from "ws";
import type { RawData } from "ws";
import type { DeviceCommand, DeviceEvent } from "./contracts/device.js";
import {
  createFirmwareServerHello,
  decodeFirmwareAudioFrame,
  isDeviceAuthorized,
  isFirmwareHello,
  type FirmwareAudioFrame,
  type FirmwareHello,
  type FirmwareProtocolVersion
} from "./device/firmware-wire.js";

export type FirmwareSessionInfo = {
  sessionId: string;
  protocolVersion: FirmwareProtocolVersion;
  hello: FirmwareHello;
};

export type GatewayHooks = {
  onFirmwareAudio?: (
    session: FirmwareSessionInfo,
    frame: FirmwareAudioFrame
  ) => void | Promise<void>;
  onFirmwareEvent?: (
    session: FirmwareSessionInfo,
    event: unknown
  ) => void | Promise<void>;
};

export type GatewayOptions = {
  deviceToken?: string;
  virtualDeviceHtml?: string;
  hooks?: GatewayHooks;
};

export type GatewayServer = {
  server: HttpServer;
  wss: WebSocketServer;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSemanticHello(value: unknown): value is Extract<DeviceEvent, { type: "hello" }> {
  return (
    isRecord(value) &&
    value.type === "hello" &&
    typeof value.deviceId === "string" &&
    value.deviceId.length > 0
  );
}

function toBytes(raw: RawData): Uint8Array {
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return raw;
}

export function createGatewayServer(options: GatewayOptions = {}): GatewayServer {
  const virtualDeviceHtml =
    options.virtualDeviceHtml ??
    resolve(process.cwd(), "virtual-device", "index.html");

  const server = createServer(async (req, res) => {
    if (req.url === "/" || req.url === "/virtual-device") {
      const html = await readFile(virtualDeviceHtml, "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "nara" }));
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  const wss = new WebSocketServer({
    server,
    path: "/device",
    verifyClient: (info: { req: IncomingMessage }) =>
      isDeviceAuthorized(info.req.headers.authorization, options.deviceToken)
  });

  wss.on("connection", (socket) => {
    const sessionId = randomUUID();
    let firmwareSession: FirmwareSessionInfo | null = null;
    let semanticClient = false;

    const sendCommand = (command: DeviceCommand) => {
      socket.send(JSON.stringify(command));
    };

    socket.on("message", async (raw, isBinary) => {
      if (isBinary) {
        if (firmwareSession === null) {
          socket.close(1002, "firmware hello required before binary audio");
          return;
        }

        try {
          const frame = decodeFirmwareAudioFrame(
            toBytes(raw),
            firmwareSession.protocolVersion
          );
          await options.hooks?.onFirmwareAudio?.(firmwareSession, frame);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "invalid firmware audio frame";
          socket.close(1002, message.slice(0, 120));
        }
        return;
      }

      let message: unknown;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        socket.close(1007, "invalid JSON");
        return;
      }

      if (isFirmwareHello(message)) {
        if (semanticClient || firmwareSession !== null) {
          socket.close(1002, "duplicate or conflicting hello");
          return;
        }

        firmwareSession = {
          sessionId,
          protocolVersion: message.version,
          hello: message
        };
        socket.send(JSON.stringify(createFirmwareServerHello(sessionId)));
        console.log(
          `[firmware:${sessionId}] connected protocol=v${message.version} input=${message.audio_params.sample_rate}Hz/${message.audio_params.frame_duration}ms`
        );
        return;
      }

      if (isSemanticHello(message)) {
        if (firmwareSession !== null || semanticClient) {
          socket.close(1002, "duplicate or conflicting hello");
          return;
        }

        semanticClient = true;
        socket.send(JSON.stringify({ type: "gateway.ready", version: 1 }));
        sendCommand({
          type: "face.set",
          interaction: "idle",
          emotion: "happy",
          intensity: 0.6,
          durationMs: 1200
        });
        return;
      }

      if (firmwareSession !== null) {
        await options.hooks?.onFirmwareEvent?.(firmwareSession, message);
        const type =
          isRecord(message) && typeof message.type === "string"
            ? message.type
            : "unknown";
        console.log(`[firmware:${sessionId}] event=${type}`);
        return;
      }

      if (!semanticClient) {
        socket.close(1002, "hello required");
        return;
      }

      const event = message as DeviceEvent;
      console.log("[device]", event);

      if (event.type === "speech.started") {
        sendCommand({
          type: "face.set",
          interaction: "listening"
        });
      }

      if (event.type === "speech.stopped") {
        sendCommand({
          type: "face.set",
          interaction: "thinking"
        });
      }
    });
  });

  return { server, wss };
}
