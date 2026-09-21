export type ConnectivityMode =
  | "online"
  | "local_gateway"
  | "peer_only"
  | "isolated";

export type RuntimeLink =
  | "wifi_sta"
  | "wifi_softap"
  | "ble"
  | "usb";

export type ProvisioningTransport =
  | "dpp"
  | "ble"
  | "softap"
  | "usb";

export interface ConnectivityObservation {
  /**
   * A configured gateway reachable through the Internet.
   *
   * This is intentionally stronger than "the Internet works": Nara cares
   * whether the route required for its cloud conversation stack is usable.
   */
  cloudGatewayReachable: boolean;

  /**
   * A compatible Nara Gateway/local voice stack is reachable on the local
   * network. This may later be a PC, home server, NAS, SBC, or phone.
   */
  localGatewayReachable: boolean;

  /**
   * A phone or other trusted peer can control/sync with the device directly,
   * even when no conversational gateway is available.
   */
  directPeerReachable: boolean;
}

/**
 * Connectivity is a capability state, not an interaction state.
 *
 * A device can remain idle/listening/speaking/local-menu independently of
 * whether its best route is cloud, a LAN gateway, a direct peer, or none.
 */
export function deriveConnectivityMode(
  observation: ConnectivityObservation
): ConnectivityMode {
  if (observation.cloudGatewayReachable) {
    return "online";
  }

  if (observation.localGatewayReachable) {
    return "local_gateway";
  }

  if (observation.directPeerReachable) {
    return "peer_only";
  }

  return "isolated";
}
