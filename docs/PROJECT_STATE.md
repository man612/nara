# Project state

This file is Nara's durable project checkpoint for humans and coding agents.

Read it after `docs/REPO_MAP.md`. Update it after every meaningful implementation batch. Do not rely on chat history as the only source of truth.

Last reviewed: 2026-09-23

## Product direction

Nara is a provider-neutral runtime for an expressive physical AI companion. The first deployment is intended for a trusted partner, but the architecture must remain reusable for multiple people, devices, characters and households.

Real names, private biography, relationship details, credentials, recordings and personal memories must remain in runtime-private storage. Public Git uses generic role names such as `owner`, `partner` and `guest`.

## What is already real

### Runtime / server

- physical firmware WebSocket handshake and Opus framing;
- session-scoped Opus/PCM transcoding using production `libopus-wasm`;
- Gemini Live realtime voice adapter;
- GPT-Live native full-duplex voice adapter with Responses delegation, Nara Action Runtime function tools, typed input, graceful close and separate voice-duration/backend-token usage;
- provider-neutral chained STT -> BrainProvider -> Action Runtime tools -> TTS voice adapter with bounded turn buffering and cancellation;
- OpenAI-compatible STT and raw-PCM TTS adapters that can target hosted or local compatible gateways;
- provider-neutral `VoiceProvider` / `VoiceSession` boundary;
- ordered connect-time voice fallback plus safe turn-boundary in-session recovery/failover after terminal provider disconnects;
- bounded playback pacing, interruption and barge-in lifecycle;
- provider usage accounting including cached versus uncached backend tokens where available and cumulative live-session voice seconds for duration-billed providers;
- provider-neutral Action Runtime with cancellation, compact tool schemas and fail-closed sensitive-action authorization;
- sensitive tools stay hidden/denied unless a session installs an explicit authorizer; firmware/phone bridges expose session-aware policy hooks;
- firmware MCP compatibility adapter isolated behind compact Nara aliases;
- privacy-filtered `personal_memory_search` available to realtime voice;
- Spotify Web API search/playback/queue/transport control behind media tools;
- authenticated browser phone-audio bridge using a separate phone credential;
- phone PCM framing and authorization-isolation integration tests;
- phone bridge can use the phone OS audio route, including a TWS headset connected to the phone;
- GitHub Releases-backed OTA catalog, stable/beta channel policy and device-authenticated OTA checks;
- persistent device claim/credential lifecycle with hashed secrets, rotation and revocation;
- provider-neutral person directory and conservative speaker-identity decision service;
- runtime speaker recognition integration that remains personalization evidence rather than private-memory authorization;
- file-backed personal memory with validation, subject/viewer access policy, sharing, expiry, bounded recall, edit/delete, fail-closed persistence and optional AES-256-GCM keyring encryption at rest;
- content/context filtering tests proving unauthorized personal facts do not reach the model;
- privacy-filtered offline personal-capsule compiler/export with recipient/viewer enforcement;
- deterministic Open-Meteo weather summaries and scheduled daily briefings;
- direct DeepSeek/OpenRouter balance/key-limit monitoring without an LLM call;
- local daily soft budget for provider-reported realtime voice tokens;
- measured voice latency telemetry with bounded p50/p95 summaries;
- optional Hermes Runs API delegation for long agent work;
- provider-neutral dedicated web search with a production SearXNG adapter, ordered fallback routing, bounded/cancellable results and a compact `web_search` voice tool;
- allowlisted Telegram bridge with ask/say/notify/status/agent commands;
- durable per-device remote inbox with TTL, leasing, retry and authenticated device poll/ack;
- idle remote delivery that keeps queued voice prompts server-side and does not require an always-on realtime model session;
- bounded authenticated network-diagnostic endpoints shared with firmware;
- WebAuthn/passkey registration and authentication with server-bound challenges, RP/origin checks and real signature verification;
- short-lived authenticated human viewer sessions plus expiring per-device trusted viewer grants;
- dynamic private-memory viewer resolution on every memory tool call, so expired/revoked physical-device grants fail back to guest;
- CI/API operational hardening: feature branches use pull-request CI only, merged `main` keeps push CI, and repository instructions require batched GitHub writes plus non-polling CI checks.

### Firmware / Waveshare 1.85B

- standalone `man612/nara-firmware` repository with pinned XiaoZhi lineage;
- full Waveshare ESP32-S3-Touch-LCD-1.85B compile in CI;
- Nara parametric face integrated into the target runtime;
- local blink/gaze/breathing and audio-driven mouth motion;
- useful no-network startup: configured devices do not fall back into endless provisioning when known Wi-Fi is temporarily absent;
- background saved-network scan/retry and automatic gateway recovery;
- ESP-IDF Wi-Fi Easy Connect / DPP QR commissioning foundation on the Waveshare 1.85B target;
- deliberate BOOT interaction for DPP commissioning/retry plus explicit fallback provisioning when the phone does not support DPP;
- physical CST816S/QMI8658 bring-up and local interaction path;
- CST816S touch-driven gaze plus deterministic tap, double-tap, hold and stroke/pet classification;
- deterministic flip/shake/spin gesture classifier foundation;
- local touch/motion reactions that do not require a gateway or AI tokens;
- persistent per-gesture reaction configuration;
- custom reaction sounds loaded from the asset partition;
- private local `reaction-assets` staging directory excluded from public Git;
- user/admin-only HTTPS complete-asset-pack install path using the existing asset partition updater;
- BQ27220 battery-level integration and automatic low/critical battery policy;
- PCF85063 RTC integration with system-clock restore and online correction;
- persistent local timer and daily-alarm state;
- offline hold-to-show-time and configurable double-tap quick timer behavior;
- face gaze target API prepared for external local vision;
- firmware OTA verification including expected SHA-256/size and device credential reuse;
- recipient-safe offline personal-capsule parsing and deterministic local lookup;
- isolated stroke/pet cycling through offline capsule facts;
- token-free Nara Says physical minigame using tap/double-tap/hold/stroke/shake;
- compact local notification/game/network-diagnostic control surface;
- bounded gateway speed test with ping, download/upload Mbps and MB/s explanation support;
- battery-aware idle remote-inbox polling and one-shot remote voice wake without microphone streaming.

### Optional external local vision

Implementation is merged in Nara Firmware and passed host checks, face-simulator tests and the full Waveshare 1.85B ESP-IDF build.

It provides:

- small ESP-IDF-native SSCMA I2C transport at the documented default address `0x62`;
- local invoke-without-image flow;
- parsing compact detection boxes from an external SSCMA-compatible vision module;
- confidence filtering, coordinate normalization, smoothing and target-loss timeout;
- highest-confidence target -> Nara face gaze;
- no continuous camera-frame upload to gateway/LLM for ordinary eye tracking;
- host tests for gaze mapping and timeout behavior.

Do not mark physical camera behavior calibrated until the actual external camera/module and enclosure exist.

## Current security boundaries

### Device identity

Implemented:

`unclaimed -> claim_pending -> active/revoked`

The registry supports one-time expiring claim transactions, separate account/physical approval gates, per-device credentials, hashed storage, rotation and revocation. Once a device is active, the legacy fleet/bootstrap token cannot impersonate it.

This proves **which Nara device** connected. It does not prove which human is currently speaking.

### Human/viewer identity

Speaker recognition is deliberately not root authentication.

Realtime speech does not infer private-memory privilege from the speaker's voice. A physical device remains guest/public-scoped unless a strong authenticated human explicitly grants that device a short-lived trusted viewer role.

WebAuthn/passkey registration and authentication are implemented. Successful passkey authentication mints the existing short-lived human viewer session, and that authenticated human can unlock/relock a physical Nara device with an expiring viewer grant. Memory tools resolve the grant again on every call, so expiry or revocation downgrades the same live voice session back to guest.

The phone-audio bridge transport credential remains separate from human authorization. Possessing the phone transport token alone does not grant trusted/private personal-memory access.

## Connectivity state

The runtime connectivity vocabulary remains:

- `online`;
- `local_gateway`;
- `peer_only`;
- `isolated`.

Phone hotspot is ordinary saved Wi-Fi station connectivity. The firmware can now remain useful/alive when saved Wi-Fi is absent and recover automatically when it returns.

When Internet/gateway access exists but the realtime voice WebSocket is closed, the device can poll a small authenticated remote inbox. The default software cadence is 15 seconds, relaxed to 60 seconds in battery saver and 120 seconds at critical battery. Local notifications do not open AI voice. A queued ask/say request opens a one-shot voice channel without enabling microphone listening, then closes after TTS or a 90-second fail-safe. These intervals are software defaults, not measured battery-life claims.

A browser phone-audio bridge exists for an online/reachable Nara Gateway, but the production **ESP32-created secure SoftAP peer UI** is still a separate staged feature. Do not confuse those two paths.

The inherited `78/esp-wifi-connect` configuration portal still uses an open SoftAP/plain HTTP model and must not be expanded into a private-data peer surface.

## Physical personality

Implemented in firmware:

- local touch/IMU sensor path;
- touch-driven gaze target;
- tap/double-tap/hold/stroke-pet classification;
- flip/shake/spin classification;
- local reaction emotion/sound policy;
- persistent gesture-specific configuration;
- custom local reaction sounds through assets.

Still hardware-calibration dependent:

- exact touch coordinate orientation;
- pet/stroke thresholds;
- face-down/upside-down orientation thresholds;
- mild/strong shake distinction;
- spin sensitivity;
- casing knock versus table/speaker vibration;
- pickup/set-down inference;
- final-enclosure thresholds.

Raw high-rate sensor streams should remain local. Cloud/LLM speech is optional enrichment after a local reflex, not the reflex itself.

## Media and phone audio

Spotify control is implemented server-side through the provider-neutral Action Runtime.

The browser phone-audio bridge is implemented and CI-tested:

`phone/TWS mic -> browser -> authenticated WebSocket -> VoiceSession -> provider`

Provider output returns as PCM to browser Web Audio. The phone OS decides the actual output device, so a connected TWS can be used without pretending ESP32-S3 supports Bluetooth Classic/LE Audio.

Still requires real-device validation:

- Android/iOS browser microphone permissions over HTTPS;
- real TWS routing;
- echo cancellation behavior;
- interruption latency;
- background/screen-lock limitations;
- browser resampling quality.

## Offline state

Already implemented:

- no-network local idle rather than repeated setup dead-end;
- background retry of saved Wi-Fi;
- automatic recovery when a known network returns;
- local face behavior;
- local physical reactions;
- local reaction sounds;
- local battery policy;
- RTC-backed clock restore/synchronization;
- persistent timer and daily alarm foundations;
- touch shortcuts for local time and a configurable quick timer;
- recipient-safe offline personal capsule parsing and deterministic lookup;
- token-free Nara Says physical minigame.

Still staged:

- richer local navigation/status UI around the utility foundation;
- local notes/messages/media beyond the implemented authorized capsule;
- direct secure SoftAP peer UI on the ESP32;
- a selected/calibrated local Indonesian STT/TTS model stack for the implemented chained voice contracts;
- production secure BLE/SoftAP fallback provisioning and real-device DPP compatibility/power validation.

Do not promise unrestricted Indonesian free-form STT/TTS on the ESP32-S3 alone. ESP-SR's supported command/TTS language limits still apply.

## Remaining work order

### P0 — hardware-in-the-loop validation

This is now the largest unavoidable blocker.

Validate on the real Waveshare board/final enclosure:

- microphone capture and physical channel mapping;
- AEC/reference path;
- noise suppression / gain / clipping;
- speaker loudness and distortion;
- barge-in;
- touch orientation and gesture behavior;
- IMU axes and all motion thresholds;
- battery gauge/charging semantics and battery life;
- Wi-Fi reconnect/hotspot behavior;
- sustained thermals/performance;
- phone/TWS browser path;
- optional camera I2C, model coordinates, field of view and gaze orientation.

CI proves code/build/protocol behavior; it cannot prove acoustics, radio conditions or physical sensor calibration.

### P1 — human authorization hardening

The passkey-first strong-viewer path is implemented: WebAuthn registration/authentication can mint short-lived human sessions, and an authenticated human can grant a physical Nara device temporary trusted/private viewer access. Speaker recognition is still only a confidence/personalization signal, and ambiguous or expired authorization fails down to guest.

Remaining hardening is product/operations work:

- browser-facing visual polish around the implemented passkey backup/revoke and device grant controls;
- account recovery when every strong authenticator is lost remains an operator/original-identity-proofing flow rather than a weaker automatic factor;
- transfer semantics between separate human accounts remain a deliberate administrative workflow;
- hardware-in-the-loop validation of the physical unlock/relock flow.

### P2 — isolated-device utility/capsule UX

The RTC/timer/alarm foundation and first recipient-safe offline capsule are
implemented, including bounded parsing, deterministic lookup and local
stroke/pet browsing. Remaining product-layer work is optional enrichment:

- richer local navigation/status around clock/timer/alarm/capsule;
- local notes/messages/media beyond the current capsule;
- explicit reconnect refresh/sync UX.

### P3 — production commissioning/direct peer

DPP QR commissioning is now implemented in firmware as the preferred standardized fast path where the phone supports Wi-Fi Easy Connect. The inherited open/plain-HTTP portal remains only an explicit fallback and must still be replaced/contained before private direct-peer data exists.

Remaining production work:

- validate DPP QR scanning, router compatibility, RF behavior and power on real phones/hardware;
- add secure SoftAP or ESP-IDF provisioning Security 2 as the universal fallback;
- application/session authorization;
- explicit physical activation;
- short-lived credentials;
- measured BLE lifecycle.

### P4 — optional ecosystem expansion

Hermes Runs API delegation is now implemented as an optional backend and does
not sit in the realtime voice critical path. Remaining ecosystem expansion is
non-blocking:

- additional search adapters beyond the implemented SearXNG path where deployment needs them;
- additional native voice providers beyond Gemini/GPT-Live and additional STT/TTS adapters;
- reminders/calendar/home automation connectors;
- richer local-network STT/LLM/TTS.

These are optional provider/features backlog, not blockers for validating the
first physical Nara.

## OTA and assets

Firmware and reaction/content assets intentionally use separate update concepts.

Firmware OTA:

- GitHub release catalog;
- stable/beta policy;
- device authorization;
- expected SHA-256/size verification on device;
- ESP image validation.

Assets:

- separate asset partition;
- local custom/private reaction sound staging;
- full asset image replacement through a user/admin-only HTTPS install command;
- conversational AI does not receive the generic asset installer.

The legacy asset format/layout checks are not equivalent to cryptographic publisher authenticity. Production asset signing/authenticity is still a hardening task.

## Hardware purchase gate

Software can no longer truthfully close the most important remaining unknowns without a real board.

See `docs/HARDWARE_PLAN.md`.

For optional person-tracking gaze, the base Waveshare board has no camera. An external SSCMA-compatible local-vision module must be purchased/wired/tested separately if that capability is desired.

## Open architectural decisions

Still intentionally open:

- visual/account-transfer polish around the implemented strong passkey lifecycle;
- private removable-media content is intentionally forbidden in the first production profile; add a per-device removable-media key lifecycle before changing that policy;
- independently updated asset-pack publisher authenticity/signature remains a separate firmware hardening item;
- exact local-network Indonesian STT/TTS/LLM stack;
- final physical gesture thresholds;
- whether two physical speech microphones plus playback reference should be exposed to the AFE after real capture analysis;
- production asset-pack signing/authenticity;
- external vision model/module choice and mounting.

Record a decision in `docs/DECISIONS.md` once evidence is sufficient.

## Checkpoint discipline

After a meaningful implementation batch:

1. update this file and README;
2. remove stale TODOs rather than leaving contradictory history;
3. distinguish CI-tested software from HIL-tested physical behavior;
4. add external technical findings to `docs/RESEARCH_SOURCES.md`;
5. update `docs/HARDWARE_PLAN.md` when hardware state changes;
6. keep private data out of Git.

A new coding agent should be able to reconstruct the current project state from the repository without reading the conversation that produced it.
