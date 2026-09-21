import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  createNetworkDiagnosticsHttpHandler,
  describeNetworkId,
  mbpsToMegabytesPerSecond
} from "../src/diagnostics/network-http.js";
import { createGatewayServer } from "../src/gateway.js";

describe("network diagnostics", () => {
  it("bounds transfer size and requires device authorization", async () => {
    const gateway = createGatewayServer({
      httpHandlers: [
        createNetworkDiagnosticsHttpHandler({
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
        `http://127.0.0.1:${port}/api/diagnostics/ping`
      );
      expect(denied.status).toBe(401);

      const download = await fetch(
        `http://127.0.0.1:${port}/api/diagnostics/download?bytes=99999999`,
        { headers: { authorization: "Bearer device-secret" } }
      );
      expect(download.status).toBe(200);
      expect((await download.arrayBuffer()).byteLength).toBe(512 * 1024);
    } finally {
      await new Promise<void>((resolve) => gateway.wss.close(() => resolve()));
      await new Promise<void>((resolve) => gateway.server.close(() => resolve()));
    }
  });

  it("explains Mbps and MB/s in plain Indonesian", () => {
    expect(mbpsToMegabytesPerSecond(80)).toBe(10);
    const text = describeNetworkId({
      rttMs: 35,
      downloadMbps: 80,
      uploadMbps: 20
    });
    expect(text).toContain("80.0 Mbps");
    expect(text).toContain("10.0 MB per detik");
    expect(text).toContain("realtime");
  });
});
