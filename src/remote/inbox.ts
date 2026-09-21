import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const storedItemSchema = z.object({
  id: z.string().min(1),
  deviceId: z.string().min(1),
  kind: z.enum(["notify", "voice"]),
  mode: z.enum(["ask", "say"]).optional(),
  text: z.string().optional(),
  prompt: z.string().optional(),
  emotion: z.string().optional(),
  sound: z.string().optional(),
  replyChatId: z.number().int().positive().optional(),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  leaseUntil: z.number().int().positive().optional()
});

const snapshotSchema = z.object({
  version: z.literal(1),
  items: z.array(storedItemSchema)
});

export type RemoteInboxVoiceItem = {
  id: string;
  deviceId: string;
  kind: "voice";
  mode: "ask" | "say";
  prompt: string;
  replyChatId?: number;
  createdAt: number;
  expiresAt: number;
  leaseUntil?: number;
};

type RemoteInboxNotifyItem = {
  id: string;
  deviceId: string;
  kind: "notify";
  text: string;
  emotion?: string;
  sound?: string;
  createdAt: number;
  expiresAt: number;
  leaseUntil?: number;
};

type RemoteInboxItem = RemoteInboxVoiceItem | RemoteInboxNotifyItem;

export type RemoteInboxPollItem =
  | {
      id: string;
      kind: "voice";
      mode: "ask" | "say";
    }
  | {
      id: string;
      kind: "notify";
      text: string;
      emotion?: string;
      sound?: string;
    };

export class RemoteInbox {
  private readonly items: RemoteInboxItem[] = [];
  private persistChain: Promise<void> = Promise.resolve();

  private constructor(
    private readonly options: {
      filePath: string;
      ttlMs: number;
      leaseMs: number;
      maxPerDevice: number;
      now: () => number;
    }
  ) {}

  static async open(options: {
    filePath: string;
    ttlMs?: number;
    leaseMs?: number;
    maxPerDevice?: number;
    now?: () => number;
  }): Promise<RemoteInbox> {
    const inbox = new RemoteInbox({
      filePath: options.filePath,
      ttlMs: options.ttlMs ?? 15 * 60_000,
      leaseMs: options.leaseMs ?? 45_000,
      maxPerDevice: options.maxPerDevice ?? 16,
      now: options.now ?? (() => Date.now())
    });

    if (inbox.options.ttlMs < 30_000) {
      throw new Error("Remote inbox TTL must be at least 30 seconds");
    }
    if (
      inbox.options.leaseMs < 5_000 ||
      inbox.options.leaseMs >= inbox.options.ttlMs
    ) {
      throw new Error("Remote inbox lease must be >=5s and shorter than TTL");
    }
    if (
      !Number.isInteger(inbox.options.maxPerDevice) ||
      inbox.options.maxPerDevice < 1 ||
      inbox.options.maxPerDevice > 128
    ) {
      throw new Error("Remote inbox maxPerDevice must be from 1 to 128");
    }

    try {
      const parsed = snapshotSchema.parse(
        JSON.parse(await readFile(inbox.options.filePath, "utf8"))
      );
      for (const raw of parsed.items) {
        const item = inbox.parseStoredItem(raw);
        if (item.expiresAt > inbox.options.now()) {
          inbox.items.push(item);
        }
      }
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return inbox;
      }
      throw new Error(
        "Remote inbox snapshot is invalid: " +
          (error instanceof Error ? error.message : String(error))
      );
    }

    return inbox;
  }

  async enqueueVoice(input: {
    deviceId: string;
    mode: "ask" | "say";
    prompt: string;
    replyChatId?: number;
  }): Promise<string> {
    const deviceId = this.cleanDeviceId(input.deviceId);
    const prompt = input.prompt.trim();
    if (!prompt || prompt.length > 4000) {
      throw new Error("Remote voice prompt must be 1 to 4000 characters");
    }
    if (
      input.replyChatId !== undefined &&
      (!Number.isSafeInteger(input.replyChatId) || input.replyChatId <= 0)
    ) {
      throw new Error("Remote reply chat ID must be a positive integer");
    }

    const now = this.options.now();
    this.purgeExpired(now);
    this.assertCapacity(deviceId);

    const id = randomUUID();
    this.items.push({
      id,
      deviceId,
      kind: "voice",
      mode: input.mode,
      prompt,
      ...(input.replyChatId !== undefined
        ? { replyChatId: input.replyChatId }
        : {}),
      createdAt: now,
      expiresAt: now + this.options.ttlMs
    });
    await this.persist();
    return id;
  }

  async enqueueNotification(input: {
    deviceId: string;
    text: string;
    emotion?: string;
    sound?: string;
  }): Promise<string> {
    const deviceId = this.cleanDeviceId(input.deviceId);
    const text = input.text.trim();
    if (!text || text.length > 220) {
      throw new Error("Remote notification text must be 1 to 220 characters");
    }
    if (input.emotion !== undefined && input.emotion.length > 24) {
      throw new Error("Remote notification emotion is too long");
    }
    if (input.sound !== undefined && input.sound.length > 110) {
      throw new Error("Remote notification sound is too long");
    }

    const now = this.options.now();
    this.purgeExpired(now);
    this.assertCapacity(deviceId);

    const id = randomUUID();
    this.items.push({
      id,
      deviceId,
      kind: "notify",
      text,
      ...(input.emotion ? { emotion: input.emotion } : {}),
      ...(input.sound ? { sound: input.sound } : {}),
      createdAt: now,
      expiresAt: now + this.options.ttlMs
    });
    await this.persist();
    return id;
  }

  async poll(deviceIdInput: string): Promise<RemoteInboxPollItem | null> {
    const deviceId = this.cleanDeviceId(deviceIdInput);
    const now = this.options.now();
    const purged = this.purgeExpired(now);
    const item = this.items.find(
      (candidate) =>
        candidate.deviceId === deviceId &&
        (candidate.leaseUntil === undefined ||
          candidate.leaseUntil <= now)
    );

    if (!item) {
      if (purged) await this.persist();
      return null;
    }

    item.leaseUntil = now + this.options.leaseMs;
    await this.persist();

    if (item.kind === "voice") {
      return {
        id: item.id,
        kind: "voice",
        mode: item.mode
      };
    }
    return {
      id: item.id,
      kind: "notify",
      text: item.text,
      ...(item.emotion ? { emotion: item.emotion } : {}),
      ...(item.sound ? { sound: item.sound } : {})
    };
  }

  async claimLeasedVoice(
    deviceIdInput: string
  ): Promise<RemoteInboxVoiceItem | undefined> {
    const deviceId = this.cleanDeviceId(deviceIdInput);
    const now = this.options.now();
    this.purgeExpired(now);

    const index = this.items.findIndex(
      (item) =>
        item.deviceId === deviceId &&
        item.kind === "voice" &&
        item.leaseUntil !== undefined &&
        item.leaseUntil > now
    );
    if (index < 0) return undefined;

    const [item] = this.items.splice(index, 1);
    await this.persist();
    return item?.kind === "voice" ? item : undefined;
  }

  async requeueVoice(item: RemoteInboxVoiceItem): Promise<void> {
    const now = this.options.now();
    if (item.expiresAt <= now) return;
    this.purgeExpired(now);
    if (
      this.items.some((candidate) => candidate.id === item.id)
    ) {
      return;
    }
    this.assertCapacity(item.deviceId);
    this.items.unshift({
      ...item,
      leaseUntil: undefined
    });
    await this.persist();
  }

  async ack(deviceIdInput: string, id: string): Promise<boolean> {
    const deviceId = this.cleanDeviceId(deviceIdInput);
    if (!id.trim()) return false;
    const index = this.items.findIndex(
      (item) => item.deviceId === deviceId && item.id === id
    );
    if (index < 0) return false;
    this.items.splice(index, 1);
    await this.persist();
    return true;
  }

  pendingCount(deviceIdInput?: string): number {
    const now = this.options.now();
    this.purgeExpired(now);
    if (!deviceIdInput) return this.items.length;
    const deviceId = this.cleanDeviceId(deviceIdInput);
    return this.items.filter((item) => item.deviceId === deviceId).length;
  }

  private parseStoredItem(
    raw: z.infer<typeof storedItemSchema>
  ): RemoteInboxItem {
    if (raw.kind === "voice") {
      if (!raw.mode || !raw.prompt) {
        throw new Error("Stored remote voice item is incomplete");
      }
      return {
        id: raw.id,
        deviceId: raw.deviceId,
        kind: "voice",
        mode: raw.mode,
        prompt: raw.prompt,
        ...(raw.replyChatId !== undefined
          ? { replyChatId: raw.replyChatId }
          : {}),
        createdAt: raw.createdAt,
        expiresAt: raw.expiresAt,
        ...(raw.leaseUntil !== undefined
          ? { leaseUntil: raw.leaseUntil }
          : {})
      };
    }
    if (!raw.text) {
      throw new Error("Stored remote notification is incomplete");
    }
    return {
      id: raw.id,
      deviceId: raw.deviceId,
      kind: "notify",
      text: raw.text,
      ...(raw.emotion ? { emotion: raw.emotion } : {}),
      ...(raw.sound ? { sound: raw.sound } : {}),
      createdAt: raw.createdAt,
      expiresAt: raw.expiresAt,
      ...(raw.leaseUntil !== undefined
        ? { leaseUntil: raw.leaseUntil }
        : {})
    };
  }

  private cleanDeviceId(value: string): string {
    const deviceId = value.trim();
    if (!deviceId || deviceId.length > 160) {
      throw new Error("Remote inbox device ID is invalid");
    }
    return deviceId;
  }

  private assertCapacity(deviceId: string): void {
    const count = this.items.filter(
      (item) => item.deviceId === deviceId
    ).length;
    if (count >= this.options.maxPerDevice) {
      throw new Error("Remote inbox is full for this device");
    }
  }

  private purgeExpired(now: number): boolean {
    const before = this.items.length;
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      if (this.items[index]!.expiresAt <= now) {
        this.items.splice(index, 1);
      }
    }
    return before !== this.items.length;
  }

  private async persist(): Promise<void> {
    const snapshot = JSON.stringify(
      {
        version: 1,
        items: this.items
      },
      null,
      2
    ) + "\n";

    this.persistChain = this.persistChain.then(async () => {
      await mkdir(dirname(this.options.filePath), { recursive: true });
      const temp =
        this.options.filePath + ".tmp-" + process.pid.toString();
      await writeFile(temp, snapshot, {
        encoding: "utf8",
        mode: 0o600
      });
      await rename(temp, this.options.filePath);
    });
    await this.persistChain;
  }
}
