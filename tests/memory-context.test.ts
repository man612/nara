import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  BrainProvider,
  BrainRequest,
  BrainResponse
} from "../src/contracts/providers.js";
import { KnownPersonResolver } from "../src/identity/people.js";
import { PersonalBrainService } from "../src/memory/context.js";
import {
  FilePersonalMemoryStore,
  type PersonalMemoryFact
} from "../src/memory/personal.js";

const directories: string[] = [];

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "nara-context-"));
  directories.push(directory);
  const filePath = join(directory, "personal-memory.json");
  return {
    filePath,
    store: new FilePersonalMemoryStore(filePath)
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
    text: "The owner likes practical technology.",
    source: { type: "manual" },
    sensitivity: "private",
    createdAt: "2026-09-21T00:00:00.000Z",
    updatedAt: "2026-09-21T00:00:00.000Z",
    ...overrides
  };
}

class CapturingBrain implements BrainProvider {
  readonly id = "capture";
  requests: BrainRequest[] = [];

  async complete(request: BrainRequest): Promise<BrainResponse> {
    this.requests.push(structuredClone(request));
    return { text: "ok", providerId: this.id };
  }
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("known person viewer resolution", () => {
  const resolver = new KnownPersonResolver([
    {
      personId: "person:partner",
      accountIds: ["account:partner"]
    }
  ]);

  it("maps a strongly authenticated account to its person", () => {
    expect(
      resolver.resolve({ authenticatedAccountId: "account:partner" })
    ).toEqual({
      viewerId: "person:partner",
      source: "authenticated_account"
    });
  });

  it("does not elevate a speaker-recognition candidate into memory access", () => {
    expect(
      resolver.resolve({
        speakerCandidate: {
          personId: "person:partner",
          confidence: 0.999
        }
      })
    ).toEqual({
      viewerId: "person:guest",
      source: "guest"
    });
  });
});

describe("personal context boundary", () => {
  it("never sends unauthorized facts to the brain provider", async () => {
    const { store } = await createStore();
    await store.upsert(
      fact("shared", {
        text: "The owner enjoys building useful software tools.",
        sensitivity: "trusted",
        shareWith: ["person:partner"]
      })
    );
    await store.upsert(
      fact("secret", {
        text: "ULTRA_PRIVATE_MARKER should never leave the policy boundary.",
        sensitivity: "private"
      })
    );

    const brain = new CapturingBrain();
    const service = new PersonalBrainService(brain, store);

    const result = await service.complete({
      viewerId: "person:partner",
      subjectId: "person:owner",
      query: "software private marker",
      request: {
        messages: [
          { role: "user", content: "What software does the owner like?" }
        ]
      }
    });

    expect(result.context.facts.map((item) => item.id)).toEqual(["shared"]);
    expect(brain.requests).toHaveLength(1);

    const serialized = JSON.stringify(brain.requests[0]);
    expect(serialized).toContain("useful software tools");
    expect(serialized).not.toContain("ULTRA_PRIVATE_MARKER");
    expect(serialized).not.toContain('"id":"secret"');
  });

  it("sends no memory system message when the viewer has no authorized match", async () => {
    const { store } = await createStore();
    await store.upsert(
      fact("secret", {
        text: "Private only.",
        sensitivity: "private"
      })
    );

    const brain = new CapturingBrain();
    const service = new PersonalBrainService(brain, store);
    await service.complete({
      viewerId: "person:guest",
      subjectId: "person:owner",
      query: "private",
      request: {
        messages: [{ role: "user", content: "Tell me about the owner." }]
      }
    });

    expect(brain.requests[0]?.messages).toEqual([
      { role: "user", content: "Tell me about the owner." }
    ]);
  });

  it("rejects malformed persisted records instead of trusting arbitrary JSON", async () => {
    const { filePath, store } = await createStore();
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        facts: [
          {
            id: "bad",
            subjectId: "",
            kind: "profile",
            text: "",
            source: { type: "unknown" },
            sensitivity: "root",
            createdAt: "not-a-date",
            updatedAt: "not-a-date"
          }
        ]
      }),
      "utf8"
    );

    await expect(
      store.recall({
        viewerId: "person:guest",
        subjectId: "person:owner",
        query: ""
      })
    ).rejects.toThrow(/Invalid or unsupported personal memory file/);
  });

  it("rejects malformed writes before they reach persistent storage", async () => {
    const { store } = await createStore();

    await expect(
      store.upsert(
        fact("bad-confidence", {
          confidence: 4
        })
      )
    ).rejects.toThrow();
  });
});
