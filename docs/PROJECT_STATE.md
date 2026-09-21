# Project state

This file is Nara's durable project checkpoint for humans and coding agents.

Read it after `docs/REPO_MAP.md`. Update it after every meaningful implementation batch. Do not rely on chat history as the only source of truth.

Last reviewed: 2026-09-21

## Product direction

Nara is a provider-neutral runtime for an expressive physical AI companion. The first deployment is intended for a trusted partner, but the architecture must remain reusable for multiple people, devices, characters and households.

Real names, private biography, relationship details, credentials, recordings and personal memories must remain in runtime-private storage. Public Git uses generic role names such as `owner`, `partner` and `guest`.

## What is already real

### Runtime / server

- physical firmware WebSocket handshake and Opus framing;
- session-scoped Opus/PCM transcoding using production `libopus-wasm`;
- Gemini Live realtime voice adapter;
- provider-neutral `VoiceProvider` / `VoiceSession` boundary;
- ordered connect-time voice fallback;
- bounded playback pacing, interruption and barge-in lifecycle;
- provider usage/token accounting including cached versus uncached input where available;
- provider-neutral Action Runtime with cancellation and compact tool schemas;
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
- file-backed personal memory with validation, subject/viewer access policy, sharing, expiry, bounded recall, edit/delete and fail-closed persistence;
- content/context filtering tests proving unauthorized personal facts do not reach the model.

### Firmware / Waveshare 1.85B

- standalone `man612/nara-firmware` repository with pinned XiaoZhi lineage;
- full Waveshare ESP32-S3-Touch-LCD-1.85B compile in CI;
- Nara parametric face integrated into the target runtime;
- local blink/gaze/breathing and audio-driven mouth motion;
- useful no-network startup: configured devices do not fall back into endless provisioning when known Wi-Fi is temporarily absent;
- background saved-network scan/retry and automatic gateway recovery;
- deliberate BOOT long-press recovery into Wi-Fi configuration;
- physical CST816S/QMI8658 bring-up and local interaction path;
- deterministic flip/shake/spin gesture classifier foundation;
- local gesture reactions that do not require a gateway or AI tokens;
- persistent per-gesture reaction configuration;
- custom reaction sounds loaded from the asset partition;
- private local `reaction-assets` staging directory excluded from public Git;
- user/admin-only HTTPS complete-asset-pack install path using the existing asset partition updater;
- BQ27220 battery-level integration and automatic low/critical battery policy;
- face gaze target API prepared for external local vision;
- firmware OTA verification including expected SHA-256/size and device credential reuse.

### Optional external local vision

Implementation exists on firmware PR #13 and is in final full-target CI at this checkpoint.

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

Current realtime personal-memory tools bind the viewer server-side to `person:guest`. Therefore realtime speech can retrieve only facts shareable with a guest/public viewer.

A strong phone/account/passkey or explicit physical approval signal is still required before trusted/private personal-memory privilege can be bound to a live session.

The phone-audio bridge token authorizes that transport only. It also does not automatically grant trusted/private personal-memory access.

## Connectivity state

The runtime connectivity vocabulary remains:

- `online`;
- `local_gateway`;
- `peer_only`;
- `isolated`.

Phone hotspot is ordinary saved Wi-Fi station connectivity. The firmware can now remain useful/alive when saved Wi-Fi is absent and recover automatically when it returns.

A browser phone-audio bridge exists for an online/reachable Nara Gateway, but the production **ESP32-created secure SoftAP peer UI** is still a separate staged feature. Do not confuse those two paths.

The inherited `78/esp-wifi-connect` configuration portal still uses an open SoftAP/plain HTTP model and must not be expanded into a private-data peer surface.

## Physical personality

Implemented in firmware:

- local touch/IMU sensor path;
- local gaze/touch behavior foundation;
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
- local battery policy.

Still staged:

- touch-driven local clock/timer/alarm UX;
- offline personal capsule compiler/storage/search;
- direct secure SoftAP peer UI on the ESP32;
- local-network STT/LLM/TTS adapters;
- production DPP / secure provisioning migration.

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

### P1 — strong human authorization

Bind a strong authenticated human viewer to sessions before private/trusted memory is exposed.

Required properties:

- transport/device authentication is not enough;
- speaker recognition remains a confidence signal only;
- ambiguous identity fails down to guest, not up to owner/partner;
- private-memory access uses the same existing viewer policy;
- reset/transfer/revoke lifecycle remains explicit.

Passkey-first account authentication remains the preferred product direction.

### P2 — isolated-device utility/capsule UX

Implement the richer no-network product layer:

- RTC-backed clock/timer/alarm;
- local navigation/status;
- permission-filtered offline personal capsule;
- deterministic local lookup;
- local notes/messages/media;
- reconnect refresh/sync.

### P3 — production commissioning/direct peer

Replace/contain the inherited open provisioning path before private direct-peer data exists:

- secure SoftAP or ESP-IDF provisioning Security 2;
- DPP where supported;
- application/session authorization;
- explicit physical activation;
- short-lived credentials;
- measured BLE lifecycle.

### P4 — optional ecosystem expansion

Only after the privacy/physical product path is dependable:

- web/search adapter;
- optional Hermes delegation;
- additional voice providers such as GPT Live/chained local voice;
- reminders/calendar/home automation;
- richer local-network STT/LLM/TTS.

These are provider/features backlog, not blockers for validating the first physical Nara.

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

- concrete passkey/account service and recovery UX;
- encryption-at-rest/key ownership for private memory;
- first production offline-capsule format and removable-media protection;
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
