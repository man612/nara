import { describe, expect, it } from "vitest";
import type { PersonalMemoryStore } from "../src/memory/personal.js";
import { PersonalMemoryToolProvider } from "../src/memory/tool-provider.js";

describe("PersonalMemoryToolProvider", () => {
  it("binds viewer and subject server-side instead of trusting model arguments", async () => {
    const recalls: unknown[] = [];
    const store: PersonalMemoryStore = {
      async upsert() {},
      async remove() {
        return false;
      },
      async recall(query) {
        recalls.push(query);
        return [
          {
            id: "public-1",
            subjectId: query.subjectId,
            kind: "profile",
            text: "The owner likes practical technology.",
            source: { type: "manual" },
            sensitivity: "public",
            shareWith: ["person:someone-else"],
            createdAt: "2026-09-21T00:00:00.000Z",
            updatedAt: "2026-09-21T00:00:00.000Z"
          }
        ];
      }
    };

    const provider = new PersonalMemoryToolProvider(store, {
      viewerId: "person:guest",
      subjectId: "person:owner"
    });

    const result = await provider.callTool(
      {
        name: "personal_memory_search",
        arguments: {
          query: "technology",
          viewerId: "person:owner",
          subjectId: "person:someone-else"
        },
        callId: "memory-1"
      },
      new AbortController().signal
    );

    expect(recalls).toEqual([
      {
        viewerId: "person:guest",
        subjectId: "person:owner",
        query: "technology",
        limit: 5
      }
    ]);

    expect(result).toMatchObject({
      name: "personal_memory_search",
      ok: true,
      callId: "memory-1",
      value: [
        {
          kind: "profile",
          text: "The owner likes practical technology.",
          sourceType: "manual"
        }
      ],
      scheduling: "silent"
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("shareWith");
    expect(serialized).not.toContain("sensitivity");
    expect(serialized).not.toContain("person:someone-else");
  });

  it("rejects invalid or oversized queries", async () => {
    const store: PersonalMemoryStore = {
      async upsert() {},
      async remove() {
        return false;
      },
      async recall() {
        throw new Error("should not be called");
      }
    };

    const provider = new PersonalMemoryToolProvider(store, {
      viewerId: "person:guest",
      subjectId: "person:owner"
    });

    await expect(
      provider.callTool(
        {
          name: "personal_memory_search",
          arguments: { query: "" }
        },
        new AbortController().signal
      )
    ).resolves.toMatchObject({ ok: false });

    await expect(
      provider.callTool(
        {
          name: "personal_memory_search",
          arguments: { query: "x".repeat(501) }
        },
        new AbortController().signal
      )
    ).resolves.toMatchObject({ ok: false });
  });
});
