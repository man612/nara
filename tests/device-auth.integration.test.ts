import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { DeviceRegistry } from "../src/device/registry.js";
import {
  createGatewayServer,
  type FirmwareSessionHandler,
  type FirmwareSessionInfo
} from "../src/gateway.js";

async function activateDevice(
  registry: DeviceRegistry,
  deviceId: string,
  clientId = "client-1"
) {
  await registry.registerUnclaimedDevice({ deviceId, clientId });
  const claim = await registry.beginClaim(deviceId);
  await registry.approveClaimFromAccount({
    claimId: claim.claimId,
    claimToken: claim.claimToken,
    accountId: "account-1"
  });
  await registry.confirmPhysicalClaim({
    claimId: claim.claimId,
    deviceId
  });
  return registry.completeClaim({
    claimId: claim.claimId,
    deviceId
  });
}

function firmwareHello() {
  return {
    type: "hello",
    version: 2,
    transport: "websocket",
    audio_params: {
      format: "opus",
      sample_rate: 16000,
      channels: 1,
      frame_duration: 60
    }
  };
}

async function listen(gateway: ReturnType<typeof createGatewayServer>) {
  await new Promise<void>((resolve) =>
    gateway.server.listen(0, "127.0.0.1", resolve)
  );
  return gateway.server.address() as AddressInfo;
}

async function closeGateway(gateway: ReturnType<typeof createGatewayServer>) {
  for (const client of gateway.wss.clients) {
    client.terminate();
  }
  await new Promise<void>((resolve) => gateway.wss.close(() => resolve()));
  await new Promise<void>((resolve, reject) =>
    gateway.server.close((error) => (error ? reject(error) : resolve()))
  );
}

describe("per-device gateway authentication", () => {
  it("requires the active device credential even when a legacy global token exists", async () => {
    const registry = await DeviceRegistry.open();
    const issued = await activateDevice(registry, "device-a");

    let resolveSession!: (session: FirmwareSessionInfo) => void;
    const sessionObserved = new Promise<FirmwareSessionInfo>((resolve) => {
      resolveSession = resolve;
    });

    const gateway = createGatewayServer({
      deviceToken: "legacy-global",
      deviceRegistry: registry,
      firmwareSessionFactory: async (session): Promise<FirmwareSessionHandler> => {
        resolveSession(session);
        return {
          onAudio() {},
          onEvent() {},
          close() {}
        };
      }
    });
    const address = await listen(gateway);

    try {
      const rejected = new WebSocket(
        `ws://127.0.0.1:${address.port}/device`,
        {
          headers: {
            "Device-Id": "device-a",
            "Client-Id": "client-1",
            Authorization: "Bearer legacy-global"
          }
        }
      );

      const rejectedError = once(rejected, "error");
      await expect(rejectedError).resolves.toBeDefined();
      rejected.terminate();

      const accepted = new WebSocket(
        `ws://127.0.0.1:${address.port}/device`,
        {
          headers: {
            "Device-Id": "device-a",
            "Client-Id": "client-1",
            Authorization: `Bearer ${issued.credential}`
          }
        }
      );

      await once(accepted, "open");
      accepted.send(JSON.stringify(firmwareHello()));

      const session = await sessionObserved;
      expect(session).toMatchObject({
        deviceId: "device-a",
        clientId: "client-1",
        protocolVersion: 2
      });

      const [message] = (await once(accepted, "message")) as [Buffer, boolean];
      expect(JSON.parse(message.toString())).toMatchObject({
        type: "hello",
        transport: "websocket"
      });

      const closed = once(accepted, "close");
      accepted.close();
      await closed;
    } finally {
      await closeGateway(gateway);
    }
  });

  it("rejects a revoked device even if it presents the old valid credential", async () => {
    const registry = await DeviceRegistry.open();
    const issued = await activateDevice(registry, "device-a");
    await registry.revokeDevice("device-a");

    const gateway = createGatewayServer({
      deviceToken: "legacy-global",
      deviceRegistry: registry
    });
    const address = await listen(gateway);

    try {
      const socket = new WebSocket(
        `ws://127.0.0.1:${address.port}/device`,
        {
          headers: {
            "Device-Id": "device-a",
            Authorization: `Bearer ${issued.credential}`
          }
        }
      );

      await expect(once(socket, "error")).resolves.toBeDefined();
      socket.terminate();
    } finally {
      await closeGateway(gateway);
    }
  });
});
