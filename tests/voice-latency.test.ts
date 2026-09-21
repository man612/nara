import { describe, expect, it } from "vitest";
import { VoiceLatencyMonitor } from "../src/telemetry/voice-latency.js";

describe("VoiceLatencyMonitor", () => {
  it("keeps bounded p50/p95 latency by device", () => {
    const monitor = new VoiceLatencyMonitor(4);
    for (const value of [400, 800, 1200, 1600, 2000]) {
      monitor.record({
        sessionId: "s-" + value,
        deviceId: "device-a",
        providerFirstAudioMs: value - 100,
        deviceFirstPacketMs: value,
        recordedAt: "2026-09-21T00:00:00.000Z"
      });
    }

    expect(monitor.summary("device-a")).toEqual({
      count: 4,
      providerFirstAudioMs: { p50: 1100, p95: 1900 },
      deviceFirstPacketMs: { p50: 1200, p95: 2000 }
    });
    expect(monitor.latest("device-a")?.deviceFirstPacketMs).toBe(2000);
  });

  it("rejects impossible negative or reversed measurements", () => {
    const monitor = new VoiceLatencyMonitor();
    monitor.record({
      sessionId: "bad",
      providerFirstAudioMs: 900,
      deviceFirstPacketMs: 800,
      recordedAt: "2026-09-21T00:00:00.000Z"
    });
    expect(monitor.summary().count).toBe(0);
  });
});
