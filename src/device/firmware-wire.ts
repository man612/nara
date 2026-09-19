import { timingSafeEqual } from "node:crypto";

export type FirmwareProtocolVersion = 1 | 2 | 3;

export type FirmwareAudioParams = {
  format: "opus";
  sample_rate: number;
  channels: 1;
  frame_duration: number;
};

export type FirmwareHello = {
  type: "hello";
  version: FirmwareProtocolVersion;
  transport: "websocket";
  features?: Record<string, unknown>;
  audio_params: FirmwareAudioParams;
  text_font?: unknown;
};

export type FirmwareServerHello = {
  type: "hello";
  transport: "websocket";
  session_id: string;
  audio_params: FirmwareAudioParams;
};

export type FirmwareAudioFrame = {
  payload: Uint8Array;
  timestamp: number;
};

const supportedVersions = new Set<number>([1, 2, 3]);
const supportedFrameDurations = new Set<number>([5, 10, 20, 40, 60, 80, 100, 120]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isFirmwareHello(value: unknown): value is FirmwareHello {
  if (!isRecord(value)) return false;
  if (value.type !== "hello" || value.transport !== "websocket") return false;
  if (typeof value.version !== "number" || !supportedVersions.has(value.version)) return false;

  const audio = value.audio_params;
  if (!isRecord(audio)) return false;

  return (
    audio.format === "opus" &&
    typeof audio.sample_rate === "number" &&
    Number.isInteger(audio.sample_rate) &&
    audio.sample_rate > 0 &&
    audio.channels === 1 &&
    typeof audio.frame_duration === "number" &&
    supportedFrameDurations.has(audio.frame_duration)
  );
}

export function createFirmwareServerHello(
  sessionId: string,
  options?: { sampleRate?: number; frameDuration?: number }
): FirmwareServerHello {
  return {
    type: "hello",
    transport: "websocket",
    session_id: sessionId,
    audio_params: {
      format: "opus",
      sample_rate: options?.sampleRate ?? 24000,
      channels: 1,
      frame_duration: options?.frameDuration ?? 60
    }
  };
}

export function decodeFirmwareAudioFrame(
  data: Uint8Array,
  version: FirmwareProtocolVersion
): FirmwareAudioFrame {
  if (data.byteLength === 0) {
    throw new Error("Empty firmware audio frame");
  }

  if (version === 1) {
    return { payload: data.slice(), timestamp: 0 };
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  if (version === 2) {
    const headerSize = 16;
    if (data.byteLength < headerSize) {
      throw new Error("Firmware protocol v2 frame is shorter than its header");
    }

    const wireVersion = view.getUint16(0, false);
    const type = view.getUint16(2, false);
    const timestamp = view.getUint32(8, false);
    const payloadSize = view.getUint32(12, false);

    if (wireVersion !== 2) {
      throw new Error(`Firmware protocol v2 header reports version ${wireVersion}`);
    }
    if (type !== 0) {
      throw new Error(`Unsupported firmware binary message type ${type}`);
    }
    if (payloadSize !== data.byteLength - headerSize) {
      throw new Error("Firmware protocol v2 payload length mismatch");
    }

    return {
      payload: data.slice(headerSize),
      timestamp
    };
  }

  const headerSize = 4;
  if (data.byteLength < headerSize) {
    throw new Error("Firmware protocol v3 frame is shorter than its header");
  }

  const type = view.getUint8(0);
  const payloadSize = view.getUint16(2, false);

  if (type !== 0) {
    throw new Error(`Unsupported firmware binary message type ${type}`);
  }
  if (payloadSize !== data.byteLength - headerSize) {
    throw new Error("Firmware protocol v3 payload length mismatch");
  }

  return {
    payload: data.slice(headerSize),
    timestamp: 0
  };
}

export function encodeFirmwareAudioFrame(
  payload: Uint8Array,
  version: FirmwareProtocolVersion,
  timestamp = 0
): Uint8Array {
  if (payload.byteLength === 0) {
    throw new Error("Cannot encode an empty firmware audio frame");
  }

  if (version === 1) {
    return payload.slice();
  }

  if (version === 2) {
    const headerSize = 16;
    const data = new Uint8Array(headerSize + payload.byteLength);
    const view = new DataView(data.buffer);
    view.setUint16(0, 2, false);
    view.setUint16(2, 0, false);
    view.setUint32(4, 0, false);
    view.setUint32(8, timestamp >>> 0, false);
    view.setUint32(12, payload.byteLength, false);
    data.set(payload, headerSize);
    return data;
  }

  if (payload.byteLength > 0xffff) {
    throw new Error("Firmware protocol v3 payload exceeds uint16 length");
  }

  const headerSize = 4;
  const data = new Uint8Array(headerSize + payload.byteLength);
  const view = new DataView(data.buffer);
  view.setUint8(0, 0);
  view.setUint8(1, 0);
  view.setUint16(2, payload.byteLength, false);
  data.set(payload, headerSize);
  return data;
}

export function isDeviceAuthorized(
  authorization: string | undefined,
  configuredToken: string | undefined
): boolean {
  if (!configuredToken) return true;
  if (!authorization) return false;

  const actual = Buffer.from(authorization);
  const expected = Buffer.from(`Bearer ${configuredToken}`);

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
