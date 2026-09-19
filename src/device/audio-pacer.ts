export type RealtimePacketPacerOptions = {
  intervalMs: number;
  send: (packet: Uint8Array) => void;
  prebufferPackets?: number;
  maxBufferedPackets?: number;
  onError?: (error: Error) => void;
};

/**
 * Keeps generated audio from flooding a small device decode queue.
 *
 * A short prebuffer is sent immediately at the beginning of each response to
 * reduce underruns. Remaining packets are paced at the device frame interval.
 */
export class RealtimePacketPacer {
  private readonly intervalMs: number;
  private readonly sendPacket: (packet: Uint8Array) => void;
  private readonly prebufferPackets: number;
  private readonly maxBufferedPackets: number;
  private readonly onError?: (error: Error) => void;
  private readonly queue: Uint8Array[] = [];
  private readonly drainWaiters = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private prebufferRemaining = 0;
  private turnOpen = false;
  private closed = false;
  private lastSentAt = 0;

  constructor(options: RealtimePacketPacerOptions) {
    if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
      throw new Error("Packet pacer interval must be positive");
    }

    this.intervalMs = options.intervalMs;
    this.sendPacket = options.send;
    this.prebufferPackets = options.prebufferPackets ?? 5;
    this.maxBufferedPackets = options.maxBufferedPackets ?? 600;
    this.onError = options.onError;

    if (
      !Number.isInteger(this.prebufferPackets) ||
      this.prebufferPackets < 0
    ) {
      throw new Error("Packet pacer prebuffer count must be a non-negative integer");
    }
    if (
      !Number.isInteger(this.maxBufferedPackets) ||
      this.maxBufferedPackets <= 0
    ) {
      throw new Error("Packet pacer buffer limit must be a positive integer");
    }
  }

  beginTurn(): void {
    this.assertOpen();
    if (this.turnOpen) return;
    if (this.queue.length > 0 || this.timer !== null) {
      throw new Error("Cannot begin a new paced turn before the previous turn drains");
    }

    this.turnOpen = true;
    this.prebufferRemaining = this.prebufferPackets;
    this.lastSentAt = 0;
  }

  enqueue(packet: Uint8Array): void {
    this.assertOpen();
    if (packet.byteLength === 0) {
      throw new Error("Cannot pace an empty audio packet");
    }
    if (!this.turnOpen) {
      this.beginTurn();
    }

    if (
      this.prebufferRemaining > 0 &&
      this.queue.length === 0 &&
      this.timer === null
    ) {
      this.sendNow(packet);
      this.prebufferRemaining -= 1;
      return;
    }

    if (this.queue.length >= this.maxBufferedPackets) {
      throw new Error(
        `Playback pacing queue exceeded ${this.maxBufferedPackets} packets`
      );
    }

    this.queue.push(packet.slice());
    this.scheduleNext();
  }

  async endTurn(): Promise<void> {
    this.turnOpen = false;
    await this.drain();
  }

  interrupt(): void {
    this.turnOpen = false;
    this.prebufferRemaining = 0;
    this.queue.length = 0;

    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    this.resolveDrainWaiters();
  }

  async drain(): Promise<void> {
    if (this.queue.length === 0 && this.timer === null) return;

    await new Promise<void>((resolve) => {
      this.drainWaiters.add(resolve);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.interrupt();
  }

  get bufferedPackets(): number {
    return this.queue.length;
  }

  private sendNow(packet: Uint8Array): void {
    this.sendPacket(packet);
    this.lastSentAt = Date.now();
  }

  private scheduleNext(): void {
    if (this.timer !== null || this.queue.length === 0 || this.closed) return;

    const elapsed = this.lastSentAt === 0 ? this.intervalMs : Date.now() - this.lastSentAt;
    const delay = Math.max(0, this.intervalMs - elapsed);

    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.closed) {
        this.resolveDrainWaiters();
        return;
      }

      const packet = this.queue.shift();
      if (!packet) {
        this.resolveDrainWaiters();
        return;
      }

      try {
        this.sendNow(packet);
      } catch (error) {
        this.fail(
          error instanceof Error ? error : new Error("Failed to send paced audio")
        );
        return;
      }

      if (this.queue.length > 0) {
        this.scheduleNext();
      } else {
        this.resolveDrainWaiters();
      }
    }, delay);
  }

  private fail(error: Error): void {
    this.queue.length = 0;
    this.turnOpen = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.resolveDrainWaiters();
    this.onError?.(error);
  }

  private resolveDrainWaiters(): void {
    if (this.queue.length > 0 || this.timer !== null) return;
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("Packet pacer is closed");
    }
  }
}
