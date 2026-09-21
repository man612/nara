import { describe, expect, it } from "vitest";
import {
  deriveConnectivityMode,
  type ConnectivityObservation,
  type ProvisioningTransport,
  type RuntimeLink
} from "../src/contracts/connectivity.js";

describe("connectivity capability model", () => {
  it("prefers a working cloud gateway when available", () => {
    expect(
      deriveConnectivityMode({
        cloudGatewayReachable: true,
        localGatewayReachable: true,
        directPeerReachable: true
      })
    ).toBe("online");
  });

  it("falls back to a local gateway without calling the device offline", () => {
    expect(
      deriveConnectivityMode({
        cloudGatewayReachable: false,
        localGatewayReachable: true,
        directPeerReachable: true
      })
    ).toBe("local_gateway");
  });

  it("keeps direct phone control useful when no gateway is reachable", () => {
    expect(
      deriveConnectivityMode({
        cloudGatewayReachable: false,
        localGatewayReachable: false,
        directPeerReachable: true
      })
    ).toBe("peer_only");
  });

  it("uses isolated only when no useful network or peer route exists", () => {
    const observation: ConnectivityObservation = {
      cloudGatewayReachable: false,
      localGatewayReachable: false,
      directPeerReachable: false
    };

    expect(deriveConnectivityMode(observation)).toBe("isolated");
  });

  it("keeps provisioning transports separate from runtime links", () => {
    const provisioning: ProvisioningTransport[] = [
      "dpp",
      "ble",
      "softap",
      "usb"
    ];
    const runtime: RuntimeLink[] = [
      "wifi_sta",
      "wifi_softap",
      "ble",
      "usb"
    ];

    expect(provisioning).toContain("dpp");
    expect(runtime).not.toContain("dpp");
  });
});
