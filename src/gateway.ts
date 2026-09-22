import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type {
  IncomingMessage,
  Server as HttpServer,
  ServerResponse
} from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import type { RawData } from "ws";
import type { AudioChunk } from "./contracts/providers.js";
import type { DeviceCommand, DeviceEvent } from "./contracts/device.js";
import {
  decodePhonePcmFrame,
  encodePhonePcmFrame
} from "./phone/protocol.js";
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

const DEFAULT_MAX_WEBSOCKET_PAYLOAD_BYTES = 256 * 1024;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

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

export type PhoneSessionTransport = {
  sendJson(message: unknown): void;
  sendAudio(chunk: AudioChunk): void;
  close(code?: number, reason?: string): void;
};

export interface PhoneSessionHandler {
  onAudio(chunk: AudioChunk): void | Promise<void>;
  onEvent(event: unknown): void | Promise<void>;
  close(): void | Promise<void>;
}

export type PhoneSessionContext = {
  viewerId?: string;
  accountId?: string;
};

export type PhoneSessionFactory = (
  transport: PhoneSessionTransport,
  context: PhoneSessionContext
) => Promise<PhoneSessionHandler>;

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

export type GatewayHttpHandler = (
  request: IncomingMessage,
  response: ServerResponse
) => Promise<boolean>;

export type GatewayOptions = {
  deviceToken?: string;
  deviceRegistry?: DeviceRegistry;
  virtualDeviceHtml?: string;
  firmwareSessionFactory?: FirmwareSessionFactory;
  phoneSessionFactory?: PhoneSessionFactory;
  phoneToken?: string;
  resolvePhoneViewerSession?: (
    sessionToken: string
  ) => PhoneSessionContext | undefined;
  phoneBridgeHtml?: string;
  httpHandlers?: GatewayHttpHandler[];
  hooks?: GatewayHooks;
  maxWebSocketPayloadBytes?: number;
  heartbeatIntervalMs?: number;
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

function secureEqualText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

function websocketProtocols(request: IncomingMessage): string[] {
  const header = headerString(request.headers["sec-websocket-protocol"]);
  if (!header) return [];
  return header
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function expectedPhoneProtocol(token: string): string {
  return `auth.${Buffer.from(token, "utf8").toString("base64url")}`;
}

function phoneViewerSessionToken(request: IncomingMessage): string | undefined {
  const protocol = websocketProtocols(request).find((value) =>
    value.startsWith("viewer.")
  );
  const token = protocol?.slice("viewer.".length);
  return token || undefined;
}

export function isGatewayPhoneAuthorized(
  request: IncomingMessage,
  phoneToken?: string
): boolean {
  if (!phoneToken) return false;
  const protocols = websocketProtocols(request);
  return (
    protocols.includes("nara-phone-v1") &&
    protocols.some((value) => secureEqualText(value, expectedPhoneProtocol(phoneToken)))
  );
}

export function isGatewayDeviceAuthorized(
  request: IncomingMessage,
  options: Pick<GatewayOptions, "deviceToken" | "deviceRegistry">
): boolean {
  const authorization = request.headers.authorization;
  const deviceId = headerString(request.headers["device-id"]);

  if (options.deviceRegistry && !options.deviceRegistry.isHealthy()) {
    return false;
  }

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
  const maxWebSocketPayloadBytes =
    options.maxWebSocketPayloadBytes ?? DEFAULT_MAX_WEBSOCKET_PAYLOAD_BYTES;
  if (
    !Number.isInteger(maxWebSocketPayloadBytes) ||
    maxWebSocketPayloadBytes < 1024 ||
    maxWebSocketPayloadBytes > 8 * 1024 * 1024
  ) {
    throw new Error("Gateway WebSocket payload limit must be from 1 KiB to 8 MiB");
  }

  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  if (
    !Number.isInteger(heartbeatIntervalMs) ||
    heartbeatIntervalMs < 0 ||
    heartbeatIntervalMs > 5 * 60_000 ||
    (heartbeatIntervalMs > 0 && heartbeatIntervalMs < 1000)
  ) {
    throw new Error("Gateway heartbeat interval must be 0 or from 1s to 5m");
  }

  const virtualDeviceHtml =
    options.virtualDeviceHtml ??
    resolve(process.cwd(), "virtual-device", "index.html");
  const phoneBridgeHtml =
    options.phoneBridgeHtml ??
    resolve(process.cwd(), "phone-bridge", "index.html");

  const server = createServer(async (req, res) => {
    if (req.url === "/" || req.url === "/virtual-device") {
      const html = await readFile(virtualDeviceHtml, "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.url === "/phone") {
      if (!options.phoneToken || !options.phoneSessionFactory) {
        res.writeHead(404);
        res.end("phone bridge is not configured");
        return;
      }
      const html = await readFile(phoneBridgeHtml, "utf8");
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' ws: wss:; media-src 'self' blob:"
      });
      res.end(html);
      return;
    }

    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "nara" }));
      return;
    }

    for (const handler of options.httpHandlers ?? []) {
      try {
        if (await handler(req, res)) {
          return;
        }
      } catch (error) {
        console.error("[http] extension handler failed", error);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
        }
        if (!res.writableEnded) {
          res.end(JSON.stringify({ ok: false, error: "internal error" }));
        }
        return;
      }
    }

    res.writeHead(404);
    res.end("not found");
  });

  const wss = new WebSocketServer({
    server,
    path: "/device",
    maxPayload: maxWebSocketPayloadBytes,
    verifyClient: (info: { req: IncomingMessage }) =>
      isGatewayDeviceAuthorized(info.req, options) ||
      isGatewayPhoneAuthorized(info.req, options.phoneToken)
  });

  const responsiveClients = new WeakSet<WebSocket>();
  if (heartbeatIntervalMs > 0) {
    const heartbeat = setInterval(() => {
      for (const client of wss.clients) {
        if (!responsiveClients.has(client)) {
          client.terminate();
          continue;
        }
        responsiveClients.delete(client);
        client.ping();
      }
    }, heartbeatIntervalMs);
    heartbeat.unref();
    wss.once("close", () => clearInterval(heartbeat));
  }

  wss.on("connection", (socket, request) => {
    const sessionId = randomUUID();
    responsiveClients.add(socket);
    socket.on("pong", () => responsiveClients.add(socket));
    socket.on("error", (error) => {
      console.warn(
        `[ws:${sessionId}] ${error instanceof Error ? error.message : String(error)}`
      );
    });
    const deviceId = headerString(request.headers["device-id"]);
    const clientId = headerString(request.headers["client-id"]);
    const deviceAuthorized = isGatewayDeviceAuthorized(request, options);
    const phoneAuthorized = isGatewayPhoneAuthorized(request, options.phoneToken);
    const viewerSessionToken = phoneViewerSessionToken(request);
    const phoneViewer =
      viewerSessionToken && options.resolvePhoneViewerSession
        ? options.resolvePhoneViewerSession(viewerSessionToken)
        : undefined;
    let firmwareSession: FirmwareSessionInfo | null = null;
    let phoneSession = false;
    let phoneHandler: PhoneSessionHandler | null = null;
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

    const createPhoneTransport = (): PhoneSessionTransport => {
      const requireOpen = () => {
        if (socket.readyState !== WebSocket.OPEN) {
          throw new Error("Phone WebSocket is not open");
        }
      };

      return {
        sendJson(message: unknown) {
          requireOpen();
          socket.send(JSON.stringify(message));
        },
        sendAudio(chunk: AudioChunk) {
          requireOpen();
          socket.send(Buffer.from(encodePhonePcmFrame(chunk)), { binary: true });
        },
        close(code = 1000, reason = "phone session closed") {
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
        try {
          if (phoneSession) {
            const chunk = decodePhonePcmFrame(toBytes(raw));
            await phoneHandler?.onAudio(chunk);
            return;
          }
          if (firmwareSession === null) {
            socket.close(1002, "hello required before binary audio");
            return;
          }

          const frame = decodeFirmwareAudioFrame(
            toBytes(raw),
            firmwareSession.protocolVersion
          );
          await firmwareHandler?.onAudio(frame);
          await options.hooks?.onFirmwareAudio?.(firmwareSession, frame);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "invalid audio frame";
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

      if (
        isRecord(message) &&
        message.type === "phone.hello" &&
        message.version === 1
      ) {
        if (!phoneAuthorized || firmwareSession !== null || semanticClient || phoneSession) {
          socket.close(1008, "phone bridge authorization required");
          return;
        }
        if (!options.phoneSessionFactory) {
          socket.close(1011, "phone bridge is not configured");
          return;
        }

        phoneSession = true;
        const transport = createPhoneTransport();
        try {
          phoneHandler = await options.phoneSessionFactory(
            transport,
            phoneViewer ?? {}
          );
          socket.send(JSON.stringify({
            type: "phone.ready",
            version: 1,
            input: { format: "pcm16le", sample_rate: 16000, channels: 1 }
          }));
          console.log(`[phone:${sessionId}] connected`);
        } catch (error) {
          console.error(`[phone:${sessionId}] setup failed`, error);
          socket.close(1011, "phone voice session setup failed");
        }
        return;
      }

      if (isFirmwareHello(message)) {
        if (!deviceAuthorized) {
          socket.close(1008, "device authorization required");
          return;
        }
        if (semanticClient || firmwareSession !== null || phoneSession) {
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
        if (!deviceAuthorized) {
          socket.close(1008, "device authorization required");
          return;
        }
        if (firmwareSession !== null || semanticClient || phoneSession) {
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

      if (phoneSession) {
        await phoneHandler?.onEvent(message);
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
          await phoneHandler?.close();
          if (firmwareSession) {
            await options.hooks?.onFirmwareClosed?.(firmwareSession);
          }
        } catch (error) {
          console.error(`[device:${sessionId}] cleanup failed`, error);
        } finally {
          firmwareHandler = null;
          firmwareTransport = null;
          phoneHandler = null;
        }
      })();
    });
  });

  return { server, wss };
}
