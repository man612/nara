import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createAccountUiHttpHandler } from "../src/identity/account-ui.js";
import { createGatewayServer } from "../src/gateway.js";

describe("account UI", () => {
  it("serves a no-store passkey management page with defensive browser headers", async () => {
    const gateway = createGatewayServer({
      httpHandlers: [createAccountUiHttpHandler()]
    });
    await new Promise<void>((resolve) =>
      gateway.server.listen(0, "127.0.0.1", resolve)
    );
    const port =
      (gateway.server.address() as AddressInfo).port;

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/account`
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control"))
        .toBe("no-store");
      expect(response.headers.get("referrer-policy"))
        .toBe("no-referrer");
      expect(response.headers.get("content-security-policy"))
        .toContain("connect-src 'self'");

      const html = await response.text();
      expect(html).toContain("Sign in with passkey");
      expect(html).toContain("Add backup passkey");
      expect(html).toContain("Unlock 10 min");
      expect(html).not.toContain("localStorage");
      expect(html).not.toContain("document.cookie");
    } finally {
      await new Promise<void>((resolve) =>
        gateway.wss.close(() => resolve())
      );
      await new Promise<void>((resolve) =>
        gateway.server.close(() => resolve())
      );
    }
  });
});
