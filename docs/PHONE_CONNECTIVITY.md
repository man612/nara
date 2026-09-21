# Phone connectivity and commissioning

Status: accepted product direction; connectivity contract foundation implemented, device-side flows remain staged.

Last reviewed: 2026-09-21


## Implementation checkpoint

Implemented now:

- phone hotspot works as ordinary saved Wi-Fi station connectivity;
- configured firmware stays out of an endless provisioning loop when saved Wi-Fi is temporarily absent;
- saved-network retry/recovery is automatic;
- an authenticated browser `/phone` audio bridge exists on Nara Gateway;
- the browser bridge has a credential distinct from ESP32 device credentials;
- phone-only authorization cannot impersonate firmware;
- the bridge sends/receives PCM through the same provider-neutral voice runtime;
- a TWS routed by the phone OS can therefore act as the phone-side mic/output path.

Important distinction: the implemented browser/TWS bridge requires reachability to Nara Gateway. The separate direct **ESP32 SoftAP + private local peer UI with no LAN/Internet** is still staged and must not reuse the inherited open/plain-HTTP provisioning portal for private data.

## Product goal

A phone should make Nara easier to set up, carry, recover, control and use offline without becoming a permanent dependency.

The first product should work in all of these situations:

1. normal Wi-Fi at home;
2. phone hotspot while travelling;
3. direct phone-to-Nara access when there is no Internet;
4. no phone and no network at all.

The transport should match the job rather than forcing everything through Bluetooth or everything through a cloud app.

## Connectivity hierarchy

### Normal operation — Wi-Fi station

Nara joins an existing 2.4 GHz Wi-Fi network in station mode.

That network may be:

- a home/office router;
- a phone hotspot/tethering network;
- a travel router;
- a local-only LAN with a Nara Gateway.

Wi-Fi remains the primary data plane for realtime voice, gateway traffic, updates, larger sync and local-network services.

A phone hotspot needs no special Nara transport. To the ESP32 it is simply another saved Wi-Fi network.

### First-use commissioning — phone assisted

The phone is the trusted high-input device. Nara should not ask the user to type or speak long Wi-Fi/account credentials on the 1.85-inch display.

Preferred hierarchy:

1. **QR + Wi-Fi Easy Connect / DPP** when the phone supports it;
2. **secure BLE provisioning** when a Nara phone client is available;
3. **secure SoftAP provisioning** as the universal no-app fallback;
4. **USB development/recovery** for engineering, not normal consumer onboarding.

The QR is an onboarding selector/proof-of-possession aid, not itself the data transport.

Account/device claiming remains separate from Wi-Fi provisioning. See `ONBOARDING_IDENTITY.md`.

### Direct phone peer — no Internet required

The first direct-phone product milestone should use an **on-demand Wi-Fi SoftAP plus local web UI**.

Example:

```text
Phone
  |
  | joins Nara-AB12 local Wi-Fi
  v
Nara SoftAP
  |
  +-- local status
  +-- Wi-Fi setup/change
  +-- battery / diagnostics
  +-- volume / brightness
  +-- offline capsule browsing
  +-- message/media sync
  +-- export logs
```

Why this is the first baseline:

- it works from a browser and does not require a native app;
- Wi-Fi has much more practical throughput for photos/audio/logs than BLE;
- it does not require keeping the BLE stack alive during normal voice use;
- the same local web surface can later be wrapped by a native app if useful.

The SoftAP should be started only when explicitly needed: first setup, recovery, a direct-peer request, or a deliberate local action. It should not remain permanently discoverable.

### BLE — temporary or on-demand

Bluetooth Low Energy is useful for:

- nearby device discovery;
- provisioning;
- status/control messages;
- small synchronization;
- proving physical proximity;
- reopening or negotiating a richer Wi-Fi peer session.

BLE is **not** Nara's main audio/data transport on the ESP32-S3.

The first release should deinitialize or keep BLE dormant after commissioning unless a user explicitly opens a peer-control window.

Reasons:

- ESP-IDF documents meaningful provisioning-time memory cost for BLE;
- ESPHome warns that BLE plus memory-heavy voice/audio components can cause instability on ESP32-class devices;
- ESP32-S3 Wi-Fi and BLE share one 2.4 GHz radio and rely on coexistence scheduling;
- Matter commonly uses BLE for commissioning and releases it afterwards when the product does not need persistent BLE.

A later native Nara app may justify persistent/on-demand GATT services, but that should be measured on the real Waveshare device first.

A particularly relevant production reference is Home Assistant Voice Preview Edition: its factory ESPHome configuration re-enables BLE when Wi-Fi disconnects, disables BLE shortly after Wi-Fi connects, and waits for BLE to be disabled before the voice-assistant client proceeds. Nara should benchmark a similar **BLE-for-setup/recovery, off-for-normal-voice** lifecycle on the 1.85B rather than inventing an always-on policy.

## Connectivity capability model

Connectivity is independent from the face/conversation interaction state.

Nara now defines four capability modes in `src/contracts/connectivity.ts`:

```text
online
  cloud gateway is reachable

local_gateway
  cloud route unavailable, compatible LAN/phone gateway reachable

peer_only
  no conversational gateway, but trusted direct phone peer reachable

isolated
  no useful network or peer route
```

This intentionally avoids treating "Wi-Fi connected" as equivalent to "online".

Examples:

- router connected but ISP down + local PC gateway available -> `local_gateway`;
- Nara SoftAP connected to a phone, no gateway -> `peer_only`;
- known Wi-Fi temporarily unavailable -> `isolated`, not "factory setup";
- phone hotspot with Internet + cloud gateway reachable -> `online`.

## Provisioning transports are not runtime transports

Keep two concepts separate.

Provisioning transports:

```text
dpp
ble
softap
usb
```

Runtime links:

```text
wifi_sta
wifi_softap
ble
usb
```

DPP exists to provision Wi-Fi; it is not a long-lived application data channel.

Similarly, a BLE provisioning session does not imply that Nara should keep Bluetooth active forever.

## DPP / Wi-Fi Easy Connect

ESP32-S3 supports Wi-Fi Easy Connect enrollee mode with a QR code.

Useful properties:

- standardized Wi-Fi provisioning;
- public-key cryptography;
- user does not type the Wi-Fi password into Nara;
- no Nara app is required on a compatible phone;
- supports WPA2/WPA3 networks.

Limitation:

Phone/platform support is not universal. Espressif specifically documents support on some Android 10+ devices, so DPP must be an optional fast path rather than the only setup method.

## Current inherited hotspot is not a production security boundary

The current `nara-firmware` dependency `78/esp-wifi-connect ~3.3.1` is useful for development and recovery UX, but its inherited configuration portal must not be confused with the future secure Nara peer surface.

Upstream's current configuration AP:

- starts the SoftAP with `WIFI_AUTH_OPEN`;
- serves the configuration UI/API over plain HTTP;
- accepts Wi-Fi SSID/password through the local web endpoint.

Consequences:

- do **not** expose personal capsule data, photos, messages, logs containing private data, account controls, device credentials or reusable secrets through the inherited portal;
- do **not** describe joining that AP as proof that the phone/user is authorized;
- do **not** expand the inherited open portal into Nara's private direct-peer product UI.

The C3 direct-phone peer surface must be a separate security boundary. Minimum direction:

- WPA2/WPA3-protected SoftAP where supported, with PMF configured appropriately;
- application/session authentication in addition to Wi-Fi possession;
- short-lived peer-mode window and credentials;
- explicit physical action to open/reopen sensitive peer access;
- capability-scoped local API;
- no reusable human password embedded in firmware;
- private content remains viewer/access filtered.

Wi-Fi link encryption is not a replacement for application authorization, but an open AP is also not acceptable for private Nara data.

For production Wi-Fi credential provisioning, prefer DPP or ESP-IDF Unified/Network Provisioning with Security 2 rather than sending credentials through the inherited open HTTP portal.

## Secure BLE/SoftAP provisioning

For production, prefer ESP-IDF Unified Provisioning / Network Provisioning semantics over growing a proprietary provisioning protocol.

ESP-IDF supports:

- BLE GATT transport;
- SoftAP + HTTP transport;
- application security;
- Security 2 using SRP6a and AES-256-GCM.

Production principles:

- unique per-device proof-of-possession material;
- short provisioning window;
- local physical action to open/reopen it;
- close the provisioning service after success/timeout;
- never ship a fleet-wide setup password;
- do not use an open SoftAP for private configuration;
- do not keep provisioning endpoints exposed after the device is claimed.

The current inherited firmware has Hotspot provisioning and optional ESP-BluFi. Keep those as development/reference paths while the production Nara provisioning path is migrated deliberately.

## Why not require a native phone app first

A native app is valuable later for:

- smooth BLE discovery/provisioning;
- background notifications;
- phone-as-local-brain experiments;
- richer media sync;
- secure device/account management;
- OS-integrated permissions and sharing.

It is not required for the first useful phone connection.

A browser-based SoftAP local UI gives Nara a universal direct-phone recovery/control path first. That prevents Android/iOS app development from blocking the embedded product.

## Phone as a local compute node

Later, a phone may optionally host or proxy:

- speech-to-text;
- an LLM/brain;
- text-to-speech;
- personal memory;
- search/tools available on the phone.

If implemented, that route counts as `local_gateway`, not merely `peer_only`.

Do not make this a first-release dependency. Mobile background execution, battery use, thermal limits, model size, iOS/Android lifecycle differences and audio routing all need separate validation.

## User flows

### Home

```text
Nara -> home Wi-Fi -> Nara Gateway -> providers
```

### Travelling

```text
Nara -> phone hotspot -> Internet -> Nara Gateway
```

No Nara app is required for this path after the hotspot credentials are saved.

### No Internet, direct phone control

```text
user deliberately opens peer mode
  -> Nara starts temporary SoftAP
  -> phone joins Nara-XXXX
  -> local browser UI opens
  -> authenticated local session
  -> settings/status/capsule/media
  -> peer mode times out or user exits
```

### No Internet, local home server

```text
Nara -> local Wi-Fi -> local Nara Gateway
                       |-- local STT
                       |-- local brain
                       |-- local TTS
                       \-- local memory
```

### Fully isolated

```text
Nara alone
  -> face
  -> touch/IMU reflexes
  -> clock/timer/alarm
  -> local settings
  -> offline capsule/media
```

## Security boundaries

Direct phone access can expose personal data, so "same Wi-Fi" is not sufficient authorization.

Required direction:

- unclaimed device: only onboarding/recovery surface;
- claimed device: local peer session requires device-bound authorization;
- high-impact actions require stronger confirmation;
- physical action can be used to open a short pairing window;
- session credentials are short-lived;
- local web endpoints are capability-scoped;
- private capsule content follows the same viewer/share policy as server memory;
- factory reset clears claim/peer credentials;
- provisioning and peer mode visibly indicate that they are active.

Do not send reusable human passwords over BLE/SoftAP and do not hard-code a universal device secret in the public firmware.

## Radio and memory constraints

ESP32-S3 has one 2.4 GHz radio shared between Wi-Fi and BLE.

ESP-IDF supports many coexistence cases, but simultaneous operation still competes for RF time. Some SoftAP + BLE combinations are documented as less stable than normal Wi-Fi station coexistence.

Therefore:

- do not keep BLE scanning continuously;
- do not run unnecessary BLE while realtime Wi-Fi voice is active;
- benchmark provisioning with audio stopped;
- prefer Wi-Fi for high-throughput transfer;
- collect free-heap/minimum-heap metrics before and after enabling BLE;
- validate reconnect behavior after BLE is deinitialized.

## Implementation order

### C0 — capability contract

Implemented:

- define `online`, `local_gateway`, `peer_only`, `isolated`;
- keep provisioning transport separate from runtime link;
- add tests for degradation order.

### C1 — firmware identity cleanup

- Nara SSID/hostname prefix everywhere;
- Nara BLE provisioning name;
- remove remaining user-visible XiaoZhi setup branding.

### C2 — useful no-network startup

- stop treating temporary Wi-Fi failure as permanent first-use setup;
- introduce device-local offline UI;
- retain explicit action to enter provisioning.

### C3 — direct-phone SoftAP

- temporary peer AP;
- local authenticated web API/UI;
- battery/network/settings/diagnostics;
- offline capsule browsing;
- transfer path for selected media/logs;
- timeout/close behavior.

### C4 — production provisioning

- evaluate/migrate to ESP-IDF Unified/Network Provisioning;
- Security 2;
- per-device proof of possession;
- QR metadata;
- provisioning window lifecycle;
- DPP fast path on supported Android devices.

### C5 — optional native companion

- BLE discovery/provisioning;
- direct peer control;
- secure account/device management;
- phone local-compute experiment.

### C6 — hardware validation

Measure on Waveshare 1.85B:

- BLE heap delta;
- Wi-Fi voice latency with BLE active/inactive;
- SoftAP reliability;
- AP -> STA transition;
- phone hotspot reconnect;
- Android/iOS captive-portal behavior;
- DPP compatibility across available Android phones;
- battery impact.

## Acceptance criteria

Phone connectivity is ready when:

1. Nara can use a normal router and a phone hotspot with the same Wi-Fi station logic;
2. first setup has a no-app fallback;
3. a temporary loss of known Wi-Fi does not force factory-style onboarding;
4. direct phone mode works without Internet;
5. direct phone mode closes automatically or deliberately and is not permanently exposed;
6. BLE is not required for normal realtime conversation;
7. BLE provisioning can release its resources after use;
8. larger media/log transfer uses Wi-Fi rather than BLE;
9. private data cannot be read merely by joining the local AP;
10. reset/revoke invalidates old peer/device credentials;
11. cloud, local-gateway, peer-only and isolated modes are independently testable;
12. real-device tests show voice remains stable under the chosen radio/memory policy.

## External references

- ESP-IDF Unified Provisioning / Security 2
- ESP-IDF ESP32-S3 Wi-Fi Easy Connect (DPP)
- ESP-IDF ESP32-S3 RF coexistence
- ESP-IDF SoftAP + Station example
- ESP RainMaker provisioning and phone app flows
- ESPHome provisioning / Improv BLE
- Matter commissioning patterns in connectedhomeip / esp-matter

Detailed URLs and reuse notes live in `RESEARCH_SOURCES.md`.
