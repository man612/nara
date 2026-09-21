import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RemoteInbox } from "../src/remote/inbox.js";

describe("RemoteInbox", () => {
  it("persists queued voice work without exposing prompt to the device poll", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nara-inbox-"));
    const path = join(dir, "remote-inbox.json");
    let now = 1_000_000;

    try {
      const inbox = await RemoteInbox.open({
        filePath: path,
        ttlMs: 120_000,
        leaseMs: 30_000,
        now: () => now
      });
      const id = await inbox.enqueueVoice({
        deviceId: "device-a",
        mode: "ask",
        prompt: "What should Nara say?",
        replyChatId: 123
      });

      await expect(inbox.poll("device-a")).resolves.toEqual({
        id,
        kind: "voice",
        mode: "ask"
      });

      const reopened = await RemoteInbox.open({
        filePath: path,
        ttlMs: 120_000,
        leaseMs: 30_000,
        now: () => now
      });
      const claimed = await reopened.claimLeasedVoice("device-a");
      expect(claimed).toMatchObject({
        id,
        kind: "voice",
        prompt: "What should Nara say?",
        replyChatId: 123
      });
      expect(reopened.pendingCount("device-a")).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leases notifications, supports ack, and retries after lease expiry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nara-inbox-"));
    const path = join(dir, "remote-inbox.json");
    let now = 2_000_000;

    try {
      const inbox = await RemoteInbox.open({
        filePath: path,
        ttlMs: 120_000,
        leaseMs: 10_000,
        now: () => now
      });
      const id = await inbox.enqueueNotification({
        deviceId: "device-a",
        text: "Jangan lupa makan",
        emotion: "happy",
        sound: "builtin:popup"
      });

      await expect(inbox.poll("device-a")).resolves.toMatchObject({
        id,
        kind: "notify",
        text: "Jangan lupa makan"
      });
      await expect(inbox.poll("device-a")).resolves.toBeNull();

      now += 10_001;
      await expect(inbox.poll("device-a")).resolves.toMatchObject({ id });
      await expect(inbox.ack("device-a", id)).resolves.toBe(true);
      expect(inbox.pendingCount("device-a")).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("expires stale work instead of waking the device later", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nara-inbox-"));
    const path = join(dir, "remote-inbox.json");
    let now = 3_000_000;

    try {
      const inbox = await RemoteInbox.open({
        filePath: path,
        ttlMs: 30_000,
        leaseMs: 5_000,
        now: () => now
      });
      await inbox.enqueueVoice({
        deviceId: "device-a",
        mode: "say",
        prompt: "Old message"
      });
      now += 30_001;
      await expect(inbox.poll("device-a")).resolves.toBeNull();
      expect(inbox.pendingCount("device-a")).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
