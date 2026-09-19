export type Emotion =
  | "neutral"
  | "happy"
  | "sad"
  | "shy"
  | "annoyed"
  | "surprised"
  | "sleepy"
  | "thinking";

export type DeviceEvent =
  | { type: "hello"; deviceId: string; capabilities?: string[] }
  | { type: "touch"; gesture: "tap" | "double_tap" | "hold" | "swipe" }
  | { type: "imu"; gesture: "lift" | "shake" | "tilt" | "face_down" }
  | { type: "speech.started" }
  | { type: "speech.stopped" };

export type DeviceCommand =
  | { type: "face.set"; emotion: Emotion; intensity?: number; durationMs?: number }
  | { type: "face.gaze"; x: number; y: number }
  | { type: "audio.interrupt" }
  | { type: "device.sleep" }
  | { type: "device.wake" };
