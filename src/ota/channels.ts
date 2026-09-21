import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { OtaChannel } from "./catalog.js";

type Snapshot = {
  version: 1;
  devices: Record<string, OtaChannel>;
};

function isChannel(value: unknown): value is OtaChannel {
  return value === "stable" || value === "beta";
}

export class DeviceUpdateChannels {
  private readonly channels = new Map<string, OtaChannel>();
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(private readonly filePath?: string) {}

  static async open(options: {
    filePath?: string;
  } = {}): Promise<DeviceUpdateChannels> {
    const registry = new DeviceUpdateChannels(options.filePath);
    await registry.load();
    return registry;
  }

  get(deviceId: string | undefined): OtaChannel {
    if (!deviceId) return "stable";
    return this.channels.get(deviceId) ?? "stable";
  }

  async set(deviceId: string, channel: OtaChannel): Promise<void> {
    if (!deviceId.trim()) {
      throw new Error("deviceId must not be empty");
    }
    if (!isChannel(channel)) {
      throw new Error("update channel must be stable or beta");
    }
    this.channels.set(deviceId, channel);
    await this.persist();
  }

  private async load(): Promise<void> {
    if (!this.filePath) return;

    try {
      const raw = await readFile(this.filePath, "utf8");
      const value = JSON.parse(raw) as unknown;
      if (
        value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        (value as { version?: unknown }).version !== 1
      ) {
        throw new Error("Invalid update-channel snapshot");
      }
      const devices = (value as { devices?: unknown }).devices;
      if (
        devices === null ||
        typeof devices !== "object" ||
        Array.isArray(devices)
      ) {
        throw new Error("Invalid update-channel device map");
      }

      for (const [deviceId, channel] of Object.entries(
        devices as Record<string, unknown>
      )) {
        if (!isChannel(channel)) {
          throw new Error(`Invalid update channel for ${deviceId}`);
        }
        this.channels.set(deviceId, channel);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  private async persist(): Promise<void> {
    if (!this.filePath) return;
    const filePath = this.filePath;
    const snapshot: Snapshot = {
      version: 1,
      devices: Object.fromEntries(this.channels)
    };

    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(filePath), { recursive: true });
      const temporary = `${filePath}.tmp`;
      await writeFile(temporary, JSON.stringify(snapshot, null, 2) + "\n", {
        encoding: "utf8",
        mode: 0o600
      });
      await rename(temporary, filePath);
    });
    await this.writeChain;
  }
}
