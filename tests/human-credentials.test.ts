import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HumanCredentialRegistry } from "../src/identity/human-credentials.js";

const tempDirs: string[] = [];

async function tempRegistry(now?: () => number) {
  const directory = await mkdtemp(join(tmpdir(), "nara-human-auth-"));
  tempDirs.push(directory);
  const filePath = join(directory, "human.json");
  return {
    registry: await HumanCredentialRegistry.open({
      filePath,
      ...(now ? { now } : {})
    }),
    filePath
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("human credential registry", () => {
  it("persists only credential hashes and issues short-lived viewer sessions", async () => {
    const { registry, filePath } = await tempRegistry();
    const issued = await registry.issue({
      personId: "person:partner",
      accountId: "account:partner"
    });

    expect(registry.verifyCredential(issued.credential)).toEqual({
      personId: "person:partner",
      accountId: "account:partner"
    });

    const raw = await readFile(filePath, "utf8");
    expect(raw).not.toContain(issued.credential);

    const reopened = await HumanCredentialRegistry.open({ filePath });
    expect(reopened.verifyCredential(issued.credential)).toEqual({
      personId: "person:partner",
      accountId: "account:partner"
    });

    const session = reopened.mintSession(issued.credential, { ttlMs: 1000 });
    expect(session.token.length).toBeGreaterThan(30);
    expect(reopened.resolveSession(session.token)).toEqual({
      personId: "person:partner",
      accountId: "account:partner"
    });
  });

  it("expires sessions and revocation invalidates credentials", async () => {
    let clock = Date.parse("2026-09-21T14:00:00.000Z");
    const { registry } = await tempRegistry(() => clock);
    const issued = await registry.issue({ personId: "person:partner" });
    const session = registry.mintSession(issued.credential, { ttlMs: 1000 });

    clock += 1001;
    expect(registry.resolveSession(session.token)).toBeUndefined();

    await registry.revoke(issued.credentialId);
    expect(registry.verifyCredential(issued.credential)).toBeUndefined();
    expect(() => registry.mintSession(issued.credential)).toThrow(/Invalid or revoked/);
  });
});
