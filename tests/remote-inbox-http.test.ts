import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGatewayServer } from "../src/gateway.js";
import { RemoteInbox } from "../src/remote/inbox.js";
import { createRemoteInboxHttpHandler } from "../src/remote/http.js";

describe("remote inbox HTTP", () => {
  it("requires device auth/id and exposes compact poll + ack", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nara-inbox-http-"));
    const inbox = await RemoteInbox.open({
      filePath: join(dir, "remote.json"),
      ttlMs: 120_000,
      leaseMs: 10_000
    });
    const id = await inbox.enqueueNotification({
      deviceId: "device-a",
      text: "hello"
    });
    const gateway = createGatewayServer({
      httpHandlers: [
        createRemoteInboxHttpHandler({
          inbox,
          authorize: (request) =>
            request.headers.authorization === "Bearer device-secret"
        })
      ]
    });
    await new Promise<void>((resolve) =>
      gateway.server.listen(0, "127.0.0.1", resolve)
    );
    const port = (gateway.server.address() as AddressInfo).port;

    try {
      const denied = await fetch(
        `http://127.0.0.1:${port}/api/device-inbox/poll`,
        { headers: { "device-id": "device-a" } }
      );
      expect(denied.status).toBe(401);

      const poll = await fetch(
        `http://127.0.0.1:${port}/api/device-inbox/poll`,
        {
          headers: {
            authorization: "Bearer device-secret",
            "device-id": "device-a"
          }
        }
      );
      await expect(poll.json()).resolves.toEqual({
        ok: true,
        item: {
          id,
          kind: "notify",
          text: "hello"
        }
      });

      const ack = await fetch(
        `http://127.0.0.1:${port}/api/device-inbox/ack`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer device-secret",
            "device-id": "device-a",
            "content-type": "application/json"
          },
          body: JSON.stringify({ id })
        }
      );
      await expect(ack.json()).resolves.toEqual({
        ok: true,
        acknowledged: true
      });
    } finally {
      await new Promise<void>((resolve) => gateway.wss.close(() => resolve()));
      await new Promise<void>((resolve) => gateway.server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });
});
