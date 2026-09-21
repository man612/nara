import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createPersonalContentHttpHandler } from "../src/content/http.js";
import { PersonalContentService } from "../src/content/personal-content.js";
import { createGatewayServer } from "../src/gateway.js";
import { FilePersonalMemoryStore } from "../src/memory/personal.js";

const directories: string[] = [];

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "nara-content-"));
  directories.push(directory);
  const store = new FilePersonalMemoryStore(join(directory, "memory.json"));
  const service = new PersonalContentService(store, {
    subjectId: "person:yasman",
    allowedViewerIds: ["person:rizma"],
    defaultViewerIds: ["person:rizma"],
    allowPublic: false,
    now: () => Date.parse("2026-09-21T12:00:00.000Z")
  });
  const token = "0123456789abcdefghijklmnopqrstuvwxyz";
  const { server } = createGatewayServer({
    httpHandlers: [
      createPersonalContentHttpHandler({
        service,
        bearerToken: token
      })
    ]
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    store,
    token,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("remote personal content API", () => {
  it("lets a scoped contributor update their own shareable facts without an AI call", async () => {
    const runtime = await setup();
    try {
      const response = await fetch(`${runtime.baseUrl}/api/personal-content/facts`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${runtime.token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          kind: "profile",
          text: "Yasman likes practical technology."
        })
      });

      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        fact: { id: string; shareWith: string[] };
      };
      expect(payload.fact.shareWith).toEqual(["person:rizma"]);

      const stored = await runtime.store.get(payload.fact.id);
      expect(stored).toMatchObject({
        subjectId: "person:yasman",
        sensitivity: "trusted",
        shareWith: ["person:rizma"],
        source: {
          type: "manual",
          reference: "remote-personal-content"
        }
      });
    } finally {
      await runtime.close();
    }
  });

  it("does not let the contributor widen sharing outside the configured recipient scope", async () => {
    const runtime = await setup();
    try {
      const response = await fetch(`${runtime.baseUrl}/api/personal-content/facts`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${runtime.token}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          kind: "profile",
          text: "Scoped fact",
          shareWith: ["person:someone-else"]
        })
      });

      expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).toContain(
        "outside contributor scope"
      );
    } finally {
      await runtime.close();
    }
  });

  it("requires the contributor token and never exposes the endpoint anonymously", async () => {
    const runtime = await setup();
    try {
      const response = await fetch(`${runtime.baseUrl}/api/personal-content/facts`);
      expect(response.status).toBe(401);
    } finally {
      await runtime.close();
    }
  });
});
