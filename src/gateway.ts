import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import type { RawData } from "ws";
import type { DeviceCommand, DeviceEvent } from "./contracts/device.js";
import {
  bearerTokenFromAuthorization,
  type DeviceRegistry
} from "./device/registry.js";
import {
  createFirmwareServerHello,
  decodeFirmwareAudioFrame,
  encodeFirmwareAudioFrame,
  isDeviceAuthorized,
  isFirmwareHello,
  type FirmwareAudioFrame,
  type FirmwareAudioParams,
  type FirmwareHello,
  type FirmwareProtocolVersion
} from "./device/firmware-wire.js";

export type FirmwareSessionInfo = {
  sessionId: string;
  protocolVersion: FirmwareProtocolVersion;
  hello: FirmwareHello;
  deviceId?: string;
  clientId?: string;
};

export type FirmwareSessionTransport = {
  readonly playback: FirmwareAudioParams;
  sendJson(message: unknown): void;
  sendAudio(payload: Uint8Array): void;
  close(code?: number, reason?: string): void;
};

export interface FirmwareSessionHandler {
  onAudio(frame: FirmwareAudioFrame): void | Promise<void>;
  onEvent(event: unknown): void | Promise<void>;
  close(): void | Promise<void>;
}

export type FirmwareSessionFactory = (
  session: FirmwareSessionInfo,
  transport: FirmwareSessionTransport
) => Promise<FirmwareSessionHandler>;

export type GatewayHooks = {
  onFirmwareAudio?: (
    session: FirmwareSessionInfo,
    frame: FirmwareAudioFrame
  ) => void | Promise<void>;
  onFirmwareEvent?: (
    session: FirmwareSessionInfo,
    event: unknown
  ) => void | Promise<void>;
  onFirmwareClosed?: (
    session: FirmwareSessionInfo
  ) => void | Promise<void>;
};

export type GatewayOptions = {
  deviceToken?: string;
  deviceRegistry?: DeviceRegistry;
  virtualDeviceHtml?: string;
  firmwareSessionFactory?: FirmwareSessionFactory;
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

function headerString(
  value: string | string[] | undefined
): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function isGatewayDeviceAuthorized(
  request: IncomingMessage,
  options: GatewayOptions
): boolean {
  const authorization = request.headers.authorization;
  const deviceId = headerString(request.headers["device-id"]);

  if (deviceId && options.deviceRegistry) {
    const state = options.deviceRegistry.getDeviceState(deviceId);

    // Once a device is active, the fleet/bootstrap token must no longer be
    // able to impersonate it. Revocation must also win over any legacy token.
    if (state === "revoked") {
      return false;
    }
    if (state === "active") {
      const credential = bearerTokenFromAuthorization(authorization);
      return (
        credential !== undefined &&
        options.deviceRegistry.verifyDeviceCredential(deviceId, credential)
      );
    }
  }

  // Development/bootstrap compatibility for devices that have not yet moved
  // to per-device credentials.
  return isDeviceAuthorized(authorization, options.deviceToken);
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
      isGatewayDeviceAuthorized(info.req, options)
  });

  wss.on("connection", (socket, request) => {
    const sessionId = randomUUID();
    const deviceId = headerString(request.headers["device-id"]);
    const clientId = headerString(request.headers["client-id"]);
    let firmwareSession: FirmwareSessionInfo | null = null;
    let firmwareHandler: FirmwareSessionHandler | null = null;
    let firmwareTransport: FirmwareSessionTransport | null = null;
    let semanticClient = false;
    let closed = false;
    let messageChain: Promise<void> = Promise.resolve();

    const sendCommand = (command: DeviceCommand) => {
      socket.send(JSON.stringify(command));
    };

    const createTransport = (
      session: FirmwareSessionInfo,
      playback: FirmwareAudioParams
    ): FirmwareSessionTransport => {
      let nextTimestamp = Date.now() >>> 0;

      const requireOpen = () => {
        if (socket.readyState !== WebSocket.OPEN) {
          throw new Error("Firmware WebSocket is not open");
        }
      };

      return {
        playback,
        sendJson(message: unknown) {
          requireOpen();
          socket.send(JSON.stringify(message));
        },
        sendAudio(payload: Uint8Array) {
          requireOpen();
          const timestamp = nextTimestamp;
          nextTimestamp = (nextTimestamp + playback.frame_duration) >>> 0;
          const framed = encodeFirmwareAudioFrame(
            payload,
            session.protocolVersion,
            timestamp
          );
          socket.send(Buffer.from(framed), { binary: true });
        },
        close(code = 1000, reason = "session closed") {
          if (
            socket.readyState === WebSocket.OPEN ||
            socket.readyState === WebSocket.CONNECTING
          ) {
            socket.close(code, reason.slice(0, 120));
          }
        }
      };
    };

    const handleMessage = async (raw: RawData, isBinary: boolean) => {
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
          await firmwareHandler?.onAudio(frame);
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
          hello: message,
          ...(deviceId ? { deviceId } : {}),
          ...(clientId ? { clientId } : {})
        };

        const serverHello = createFirmwareServerHello(sessionId);
        socket.send(JSON.stringify(serverHello));
        firmwareTransport = createTransport(
          firmwareSession,
          serverHello.audio_params
        );

        console.log(
          `[firmware:${sessionId}] connected protocol=v${message.version} input=${message.audio_params.sample_rate}Hz/${message.audio_params.frame_duration}ms`
        );

        if (options.firmwareSessionFactory) {
          try {
            firmwareHandler = await options.firmwareSessionFactory(
              firmwareSession,
              firmwareTransport
            );
          } catch (error) {
            console.error(
              `[firmware:${sessionId}] voice session setup failed`,
              error
            );
            socket.close(1011, "voice session setup failed");
          }
        }
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
        await firmwareHandler?.onEvent(message);
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
    };

    socket.on("message", (raw, isBinary) => {
      messageChain = messageChain
        .then(() => handleMessage(raw, isBinary))
        .catch((error) => {
          console.error(`[device:${sessionId}] message handling failed`, error);
          if (socket.readyState === WebSocket.OPEN) {
            socket.close(1011, "gateway message handling failed");
          }
        });
    });

    socket.on("close", () => {
      if (closed) return;
      closed = true;

      void (async () => {
        try {
          await messageChain.catch(() => undefined);
          await firmwareHandler?.close();
          if (firmwareSession) {
            await options.hooks?.onFirmwareClosed?.(firmwareSession);
          }
        } catch (error) {
          console.error(`[device:${sessionId}] cleanup failed`, error);
        } finally {
          firmwareHandler = null;
          firmwareTransport = null;
        }
      })();
    });
  });

  return { server, wss };
}
