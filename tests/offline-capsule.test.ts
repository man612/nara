import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileOfflineCapsule, capsuleSearch } from "../src/offline/capsule.js";
import { FilePersonalMemoryStore } from "../src/memory/personal.js";

const dirs: string[] = [];

async function store() {
  const directory = await mkdtemp(join(tmpdir(), "nara-capsule-"));
  dirs.push(directory);
  return new FilePersonalMemoryStore(join(directory, "memory.json"));
}

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("offline capsule compiler", () => {
  it("contains only facts the configured recipient may access", async () => {
    const memory = await store();
    const now = "2026-09-21T12:00:00.000Z";

    await memory.upsert({
      id: "public-1",
      subjectId: "person:creator",
      kind: "favorite",
      text: "Likes astronomy",
      tags: ["space", "hobby"],
      source: { type: "manual", reference: "admin-ui" },
      sensitivity: "public",
      createdAt: now,
      updatedAt: now
    });
    await memory.upsert({
      id: "shared-1",
      subjectId: "person:creator",
      kind: "message",
      text: "A private note intentionally shared with the recipient",
      tags: ["note"],
      source: { type: "manual", reference: "admin-ui" },
      sensitivity: "trusted",
      shareWith: ["person:recipient"],
      createdAt: now,
      updatedAt: now
    });
    await memory.upsert({
      id: "private-1",
      subjectId: "person:creator",
      kind: "secret",
      text: "Owner-only secret",
      source: { type: "manual" },
      sensitivity: "private",
      createdAt: now,
      updatedAt: now
    });
    await memory.upsert({
      id: "other-recipient",
      subjectId: "person:creator",
      kind: "message",
      text: "Shared with someone else",
      source: { type: "manual" },
      sensitivity: "trusted",
      shareWith: ["person:other"],
      createdAt: now,
      updatedAt: now
    });

    const capsule = await compileOfflineCapsule({
      store: memory,
      subjectPersonId: "person:creator",
      recipientPersonId: "person:recipient",
      now: new Date(now)
    });

    expect(capsule.facts.map((fact) => fact.id)).toEqual([
      "public-1",
      "shared-1"
    ]);
    expect(JSON.stringify(capsule)).not.toContain("Owner-only secret");
    expect(JSON.stringify(capsule)).not.toContain("shareWith");
    expect(JSON.stringify(capsule)).not.toContain("sensitivity");
    expect(JSON.stringify(capsule)).not.toContain("admin-ui");
    expect(capsule.revision).toMatch(/^[a-f0-9]{64}$/);
  });

  it("supports deterministic local keyword lookup over compact aliases", async () => {
    const memory = await store();
    const now = "2026-09-21T12:00:00.000Z";
    await memory.upsert({
      id: "fact-1",
      subjectId: "person:creator",
      kind: "hobby",
      text: "Builds small electronics projects",
      tags: ["electronics", "maker"],
      source: { type: "manual" },
      sensitivity: "public",
      createdAt: now,
      updatedAt: now
    });

    const capsule = await compileOfflineCapsule({
      store: memory,
      subjectPersonId: "person:creator",
      recipientPersonId: "person:recipient",
      now: new Date(now)
    });

    expect(capsuleSearch(capsule, "electronics")).toMatchObject([
      { id: "fact-1" }
    ]);
    expect(capsuleSearch(capsule, "unknown")).toEqual([]);
  });
});
