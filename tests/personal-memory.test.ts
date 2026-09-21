import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FilePersonalMemoryStore,
  canViewerAccessFact,
  type PersonalMemoryFact
} from "../src/memory/personal.js";

const createdDirectories: string[] = [];

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "nara-memory-"));
  createdDirectories.push(directory);
  const path = join(directory, "personal-memory.json");

  return {
    path,
    store: new FilePersonalMemoryStore(path)
  };
}

function fact(
  id: string,
  overrides: Partial<PersonalMemoryFact> = {}
): PersonalMemoryFact {
  return {
    id,
    subjectId: "person:owner",
    kind: "profile",
    text: "The owner works with technology and software.",
    tags: ["work", "technology"],
    source: { type: "manual", reference: "test" },
    confidence: 1,
    sensitivity: "private",
    createdAt: "2026-09-21T00:00:00.000Z",
    updatedAt: "2026-09-21T00:00:00.000Z",
    ...overrides
  };
}

afterEach(async () => {
  await Promise.all(
    createdDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("personal memory access policy", () => {
  it("lets the subject see their own facts", () => {
    expect(
      canViewerAccessFact(fact("private"), "person:owner")
    ).toBe(true);
  });

  it("requires explicit sharing for a trusted partner", () => {
    const shared = fact("shared", {
      sensitivity: "trusted",
      shareWith: ["person:partner"]
    });

    expect(canViewerAccessFact(shared, "person:partner")).toBe(true);
    expect(canViewerAccessFact(shared, "person:guest")).toBe(false);
  });

  it("allows public facts to any viewer", () => {
    expect(
      canViewerAccessFact(
        fact("public", { sensitivity: "public" }),
        "person:guest"
      )
    ).toBe(true);
  });
});

describe("file personal memory store", () => {
  it("filters unauthorized facts before recall returns context candidates", async () => {
    const { store } = await createStore();

    await store.upsert(
      fact("partner-visible", {
        text: "The owner enjoys building practical technology projects.",
        sensitivity: "trusted",
        shareWith: ["person:partner"]
      })
    );
    await store.upsert(
      fact("owner-only", {
        text: "The owner has a private surprise project.",
        sensitivity: "private"
      })
    );

    const recalled = await store.recall({
      viewerId: "person:partner",
      subjectId: "person:owner",
      query: "project"
    });

    expect(recalled.map((item) => item.id)).toEqual(["partner-visible"]);
  });

  it("falls back to public-only access for an unrelated guest", async () => {
    const { store } = await createStore();

    await store.upsert(
      fact("public", {
        text: "The owner likes technology.",
        sensitivity: "public"
      })
    );
    await store.upsert(
      fact("trusted", {
        text: "The owner likes a private technology project.",
        sensitivity: "trusted",
        shareWith: ["person:partner"]
      })
    );

    const recalled = await store.recall({
      viewerId: "person:guest",
      subjectId: "person:owner",
      query: "technology"
    });

    expect(recalled.map((item) => item.id)).toEqual(["public"]);
  });

  it("persists facts across store instances", async () => {
    const { path, store } = await createStore();

    await store.upsert(
      fact("persistent", {
        text: "The owner prefers concise technical explanations.",
        sensitivity: "trusted",
        shareWith: ["person:partner"]
      })
    );

    const reloaded = new FilePersonalMemoryStore(path);
    const recalled = await reloaded.recall({
      viewerId: "person:partner",
      subjectId: "person:owner",
      query: "technical explanations"
    });

    expect(recalled.map((item) => item.id)).toEqual(["persistent"]);

    const file = JSON.parse(await readFile(path, "utf8")) as {
      version: number;
      facts: unknown[];
    };
    expect(file.version).toBe(1);
    expect(file.facts).toHaveLength(1);
  });

  it("supports edits and deletion by stable fact id", async () => {
    const { store } = await createStore();

    await store.upsert(
      fact("editable", {
        text: "The owner likes old preference.",
        sensitivity: "public"
      })
    );
    await store.upsert(
      fact("editable", {
        text: "The owner likes updated preference.",
        sensitivity: "public",
        updatedAt: "2026-09-21T01:00:00.000Z"
      })
    );

    expect(
      (
        await store.recall({
          viewerId: "person:guest",
          subjectId: "person:owner",
          query: "updated preference"
        })
      )[0]?.text
    ).toContain("updated");

    expect(await store.remove("editable")).toBe(true);
    expect(
      await store.recall({
        viewerId: "person:guest",
        subjectId: "person:owner",
        query: "preference"
      })
    ).toEqual([]);
  });

  it("caps recall and ignores expired facts", async () => {
    const { store } = await createStore();

    for (let index = 0; index < 25; index += 1) {
      await store.upsert(
        fact(`fact-${index.toString().padStart(2, "0")}`, {
          text: `Technology preference number ${index}`,
          sensitivity: "public",
          updatedAt: `2026-09-21T00:${index.toString().padStart(2, "0")}:00.000Z`
        })
      );
    }

    await store.upsert(
      fact("expired", {
        text: "Technology preference that should expire.",
        sensitivity: "public",
        expiresAt: "2026-09-20T00:00:00.000Z"
      })
    );

    const recalled = await store.recall({
      viewerId: "person:guest",
      subjectId: "person:owner",
      query: "technology preference",
      limit: 100,
      now: "2026-09-21T12:00:00.000Z"
    });

    expect(recalled).toHaveLength(20);
    expect(recalled.some((item) => item.id === "expired")).toBe(false);
  });
});
