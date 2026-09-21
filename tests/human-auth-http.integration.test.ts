import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { PersonDirectory } from "../src/identity/directory.js";
import { HumanCredentialRegistry } from "../src/identity/human-credentials.js";
import { createHumanAuthHttpHandler } from "../src/identity/human-auth-http.js";
import { createGatewayServer } from "../src/gateway.js";

describe("human auth HTTP edge", () => {
  it("admin issues a credential and the human exchanges it for a short session", async () => {
    const registry = await HumanCredentialRegistry.open();
    const directory = new PersonDirectory([
      {
        personId: "person:owner",
        displayName: "Owner",
        role: "primary"
      },
      {
        personId: "person:partner",
        displayName: "Partner",
        role: "trusted"
      },
      {
        personId: "person:guest",
        displayName: "Guest",
        role: "guest"
      }
    ]);

    const gateway = createGatewayServer({
      httpHandlers: [
        createHumanAuthHttpHandler({
          registry,
          directory,
          adminToken: "admin-secret"
        })
      ]
    });
    await new Promise<void>((resolve) =>
      gateway.server.listen(0, "127.0.0.1", resolve)
    );
    const port = (gateway.server.address() as AddressInfo).port;

    try {
      const issue = await fetch(
        `http://127.0.0.1:${port}/api/identity/credentials`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer admin-secret",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            personId: "person:partner",
            accountId: "account:partner"
          })
        }
      );
      expect(issue.status).toBe(201);
      const issued = (await issue.json()) as {
        credential: string;
        credentialId: string;
      };
      expect(issued.credential.length).toBeGreaterThan(30);

      const session = await fetch(
        `http://127.0.0.1:${port}/api/identity/session`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${issued.credential}`
          }
        }
      );
      expect(session.status).toBe(200);
      const payload = (await session.json()) as {
        sessionToken: string;
        viewer: { personId: string; displayName: string };
      };
      expect(payload.viewer).toEqual({
        personId: "person:partner",
        displayName: "Partner",
        role: "trusted"
      });
      expect(registry.resolveSession(payload.sessionToken)).toEqual({
        personId: "person:partner",
        accountId: "account:partner"
      });

      const unauthorized = await fetch(
        `http://127.0.0.1:${port}/api/identity/credentials`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer wrong",
            "content-type": "application/json"
          },
          body: JSON.stringify({ personId: "person:owner" })
        }
      );
      expect(unauthorized.status).toBe(401);
    } finally {
      await new Promise<void>((resolve) => gateway.wss.close(() => resolve()));
      await new Promise<void>((resolve) => gateway.server.close(() => resolve()));
    }
  });
});
