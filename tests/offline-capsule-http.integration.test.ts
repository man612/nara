import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGatewayServer } from "../src/gateway.js";
import { createOfflineCapsuleHttpHandler } from "../src/offline/capsule-http.js";
import { FilePersonalMemoryStore } from "../src/memory/personal.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("offline capsule HTTP export", () => {
  it("requires admin authorization and returns only the configured recipient view", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nara-capsule-http-"));
    dirs.push(directory);
    const store = new FilePersonalMemoryStore(join(directory, "memory.json"));
    const now = "2026-09-21T12:00:00.000Z";

    await store.upsert({
      id: "allowed",
      subjectId: "person:creator",
      kind: "story",
      text: "Shareable story",
      source: { type: "manual" },
      sensitivity: "trusted",
      shareWith: ["person:recipient"],
      createdAt: now,
      updatedAt: now
    });
    await store.upsert({
      id: "blocked",
      subjectId: "person:creator",
      kind: "secret",
      text: "Never export this",
      source: { type: "manual" },
      sensitivity: "private",
      createdAt: now,
      updatedAt: now
    });

    const gateway = createGatewayServer({
      httpHandlers: [
        createOfflineCapsuleHttpHandler({
          store,
          bearerToken: "capsule-admin-token-123456789",
          recipientPersonId: "person:recipient",
          subjectPersonId: "person:creator",
          now: () => new Date(now)
        })
      ]
    });
    await new Promise<void>((resolve) =>
      gateway.server.listen(0, "127.0.0.1", resolve)
    );
    const port = (gateway.server.address() as AddressInfo).port;

    try {
      const denied = await fetch(
        `http://127.0.0.1:${port}/api/offline-capsule`
      );
      expect(denied.status).toBe(401);

      const response = await fetch(
        `http://127.0.0.1:${port}/api/offline-capsule`,
        {
          headers: {
            authorization: "Bearer capsule-admin-token-123456789"
          }
        }
      );
      expect(response.status).toBe(200);
      const capsule = (await response.json()) as {
        recipientPersonId: string;
        facts: Array<{ id: string; text: string }>;
      };
      expect(capsule.recipientPersonId).toBe("person:recipient");
      expect(capsule.facts).toEqual([
        expect.objectContaining({ id: "allowed", text: "Shareable story" })
      ]);
      expect(JSON.stringify(capsule)).not.toContain("Never export this");
    } finally {
      await new Promise<void>((resolve) => gateway.wss.close(() => resolve()));
      await new Promise<void>((resolve) => gateway.server.close(() => resolve()));
    }
  });
});
