# Nara

**Source-available runtime for expressive physical AI companions.**

Nara is a provider-neutral runtime for an expressive physical AI companion
that can listen, speak, reason, remember, use tools, coordinate device
behavior, and remain useful across online and offline capability levels.

It is intentionally not tied to one character, model provider, voice stack,
hosting platform, or hardware family. A partner-focused deployment can be the
first profile while the runtime remains reusable across people, devices, and
characters.

> **Source availability:** Nara-authored code is proprietary and published for
> transparency, inspection, and reference. Public access does not grant
> permission to use, copy, modify, redistribute, deploy, or create derivative
> works. See LICENSE.

## Architecture

    physical / virtual device
            |
            | realtime device protocol
            v
          Nara Gateway
       |        |         |
     voice     brain    character
       |        |         |
    Gemini     DeepSeek   profiles
    future     Hermes     emotion
    adapters   OpenRouter memory
            |
       Action Runtime
     device / search / memory / agents / MCP

The realtime voice path stays thin. Slow web search, browser work, long
reasoning, and automation are delegated instead of blocking
microphone/speaker streaming.

## Provider strategy

- Voice: Gemini Live is implemented; GPT-Live, Pipecat-backed runtimes, and a
  cheap chained STT -> brain -> TTS path are planned behind the same contract.
- Brain: any OpenAI-compatible endpoint; DeepSeek, Hermes, OpenRouter, and
  local gateways can share one adapter.
- Actions: provider-neutral routing/cancellation; physical-device tools execute
  through a compact firmware MCP compatibility boundary.
- Agent/tools: Hermes Agent is optional and can run on a VPS or managed
  service.
- Search: Hermes, SearXNG, DDGS, Brave, provider-native search, or future
  adapters.
- Memory: local-first; larger stores such as PostgreSQL/pgvector can be added
  when deployment needs them.
- Device: the first target is Waveshare ESP32-S3-Touch-LCD-1.85B through the
  standalone nara-firmware repository.

## Project continuity

The repository is the durable source of truth for project direction rather
than chat history.

Start with:

- AGENTS.md
- docs/REPO_MAP.md
- docs/PROJECT_STATE.md

Personal/multi-person memory design lives in docs/PERSONAL_KNOWLEDGE.md.
Offline-first behavior lives in docs/OFFLINE_RUNTIME.md. Hardware purchase/test
state lives in docs/HARDWARE_PLAN.md. Durable architectural choices live in
docs/DECISIONS.md.

Real personal knowledge is runtime-private and must never be committed to this
public repository.

## Deployment

Nara does not assume a permanent host. It can run on a laptop, home server,
generic VPS, SumoPod, or another container platform.

## Status

Nara's software core is a real end-to-end system rather than an architecture
sketch.

The physical realtime voice path supports firmware WebSocket/Opus framing,
session-scoped Opus/PCM transcoding, Gemini Live, provider-neutral
voice-session contracts, connect-time fallback, bounded playback pacing,
interruption/barge-in lifecycle, compact tool calls, normalized usage
accounting, and measured turn-end -> first-provider-audio -> first-device-audio
latency. Automated coverage includes a real-Opus firmware-to-provider round
trip and a production Node 24 Alpine image smoke test.

The Action Runtime executes compact validated tools without exposing
firmware-specific MCP details to the model. Implemented capabilities include
device status/volume, physical-reflex customization, RTC-backed utilities,
privacy-filtered personal-memory retrieval, Spotify search/playback/control,
deterministic weather/briefings, provider balance checks, voice-token budget
guards, network diagnostics, and optional Hermes Runs API delegation.

Companion services are deliberately cost-aware. Weather, provider balance,
latency/status checks, local notifications, speed tests, physical reflexes and
the offline Nara Says minigame do not need an LLM call. Realtime voice token
usage can be constrained by a local daily soft budget, while DeepSeek and
OpenRouter account/key status can be checked directly where their APIs expose
it. Hermes is optional and intended for long-running browser/research/agent
work rather than simple realtime turns.

Telegram integration is allowlisted. When a firmware voice session is already
open, remote text can be injected immediately. When the device is idle, Nara
stores work in a bounded durable per-device inbox. Firmware polls that small
authenticated control edge without keeping the realtime AI session alive.
Token-free notifications are rendered locally; queued voice requests cause a
one-shot voice channel to open only when needed. The queued prompt remains
server-side rather than being exposed through the polling response.

Identity and memory have fail-closed boundaries. Devices have a persistent
claim/credential lifecycle with rotation and revocation. Personal facts are
subject/viewer-aware, validated before persistence, and filtered before model
context. Speaker recognition remains personalization evidence, not root
authorization. WebAuthn/passkey registration and authentication are implemented
for strong human viewer sessions, and a passkey-authenticated person can grant a
short-lived trusted/private viewer role to a physical Nara device. Memory tools
re-resolve that grant on every call so expiry or revocation falls back to guest
without trusting the speaker's voice as a password. Legacy bearer credentials
remain a bootstrap/recovery path rather than the preferred daily sign-in.

The standalone Waveshare 1.85B firmware builds in full ESP-IDF CI and includes
Nara's parametric face, local audio-driven mouth motion, CST816S touch input,
touch-driven gaze, touch/IMU physical reflexes, flip/shake/spin classifiers,
persistent custom reaction packs, RTC-backed clock/timer/alarm foundations,
battery policy, saved-Wi-Fi recovery, useful no-network idle behavior,
authenticated OTA, a recipient-safe offline personal capsule reader, the
token-free Nara Says physical minigame, and lightweight network diagnostics.

A separate authenticated browser phone-audio bridge is implemented. A phone
can provide microphone/audio output to the same provider-neutral voice runtime;
when a TWS headset is routed through the phone OS, the browser path can use
that phone/TWS audio route. The phone credential is isolated from firmware
credentials and does not automatically grant private-memory access.

Optional external local vision for the Waveshare target is implemented in
Nara Firmware. A compatible SSCMA vision module can return compact local
detection boxes; normalized gaze coordinates drive Nara's eyes without
streaming ordinary tracking frames to the LLM.

The major remaining uncertainties are now physical or production-hardening
items rather than missing core companion logic: microphone/AEC/speaker tuning,
final gesture calibration, battery-life and polling measurements, phone/TWS
validation on real devices, external-camera field-of-view/orientation,
passkey recovery/account-lifecycle polish, production secure
commissioning/direct-peer mode, and optional additional
voice/search/local-network providers.

## Ownership and licensing

Copyright © 2026 **man612**. All rights reserved for original Nara material.

Nara is **source-available, not open source**. No permission to use, copy,
modify, redistribute, deploy, sublicense, sell, or create derivative works is
granted merely because this repository is public. See LICENSE.

Third-party dependencies retain their own licenses; see THIRD_PARTY_NOTICES.md.
External contributions are not accepted by default; see CONTRIBUTING.md.
