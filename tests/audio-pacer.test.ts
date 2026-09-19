import { afterEach, describe, expect, it, vi } from "vitest";
import { RealtimePacketPacer } from "../src/device/audio-pacer.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("RealtimePacketPacer", () => {
  it("prebuffers a few packets then paces the rest at the device frame interval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const sent: number[] = [];
    const pacer = new RealtimePacketPacer({
      intervalMs: 60,
      prebufferPackets: 2,
      send: (packet) => sent.push(packet[0] ?? 0)
    });

    pacer.beginTurn();
    pacer.enqueue(Uint8Array.from([1]));
    pacer.enqueue(Uint8Array.from([2]));
    pacer.enqueue(Uint8Array.from([3]));
    pacer.enqueue(Uint8Array.from([4]));

    expect(sent).toEqual([1, 2]);
    expect(pacer.bufferedPackets).toBe(2);

    await vi.advanceTimersByTimeAsync(59);
    expect(sent).toEqual([1, 2]);

    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual([1, 2, 3]);

    await vi.advanceTimersByTimeAsync(60);
    expect(sent).toEqual([1, 2, 3, 4]);

    await pacer.endTurn();
    expect(pacer.bufferedPackets).toBe(0);
  });

  it("drops queued playback immediately on interruption", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);

    const sent: number[] = [];
    const pacer = new RealtimePacketPacer({
      intervalMs: 60,
      prebufferPackets: 1,
      send: (packet) => sent.push(packet[0] ?? 0)
    });

    pacer.beginTurn();
    pacer.enqueue(Uint8Array.from([1]));
    pacer.enqueue(Uint8Array.from([2]));
    pacer.enqueue(Uint8Array.from([3]));

    expect(sent).toEqual([1]);
    expect(pacer.bufferedPackets).toBe(2);

    const draining = pacer.drain();
    pacer.interrupt();
    await draining;

    await vi.advanceTimersByTimeAsync(500);
    expect(sent).toEqual([1]);
    expect(pacer.bufferedPackets).toBe(0);
  });

  it("fails closed when the bounded playback queue is exceeded", () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000);

    const pacer = new RealtimePacketPacer({
      intervalMs: 60,
      prebufferPackets: 0,
      maxBufferedPackets: 1,
      send: () => {}
    });

    pacer.beginTurn();
    pacer.enqueue(Uint8Array.from([1]));

    expect(() => pacer.enqueue(Uint8Array.from([2]))).toThrow(
      /exceeded 1 packets/
    );
  });
});
