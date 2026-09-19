import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
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
  type FirmwareProtocolVersion
} from "./device/firmware-wire.js";

const port = Number(process.env.PORT ?? 8787);
const deviceToken = process.env.NARA_DEVICE_TOKEN;
const virtualDeviceHtml = resolve(process.cwd(), "virtual-device", "index.html");

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
  verifyClient: ({ req }) => isDeviceAuthorized(req.headers.authorization, deviceToken)
});

wss.on("connection", (socket) => {
  const sessionId = randomUUID();
  let firmwareVersion: FirmwareProtocolVersion | null = null;
  let semanticClient = false;

  const sendCommand = (command: DeviceCommand) => {
    socket.send(JSON.stringify(command));
  };

  socket.on("message", (raw, isBinary) => {
    if (isBinary) {
      if (firmwareVersion === null) {
        socket.close(1002, "firmware hello required before binary audio");
        return;
      }

      try {
        decodeFirmwareAudioFrame(toBytes(raw), firmwareVersion);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid firmware audio frame";
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
      if (semanticClient || firmwareVersion !== null) {
        socket.close(1002, "duplicate or conflicting hello");
        return;
      }

      firmwareVersion = message.version;
      socket.send(JSON.stringify(createFirmwareServerHello(sessionId)));
      console.log(
        `[firmware:${sessionId}] connected protocol=v${firmwareVersion} input=${message.audio_params.sample_rate}Hz/${message.audio_params.frame_duration}ms`
      );
      return;
    }

    if (isSemanticHello(message)) {
      if (firmwareVersion !== null || semanticClient) {
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

    if (firmwareVersion !== null) {
      const type = isRecord(message) && typeof message.type === "string" ? message.type : "unknown";
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

server.listen(port, () => {
  console.log(`Companion gateway: http://localhost:${port}`);
  console.log(`Virtual device:   http://localhost:${port}/virtual-device`);
  if (!deviceToken) {
    console.warn("NARA_DEVICE_TOKEN is not set; /device accepts unauthenticated clients");
  }
});
