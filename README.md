# Nara

**Open runtime for expressive physical AI.**

Nara is a provider-neutral runtime for building small physical AI companions that can listen, speak, reason, remember, use tools, and drive a local expressive interface.

It is intentionally not tied to one character, one model provider, one voice stack, or one hardware platform. A partner/"doi" personality can be the first profile while the runtime stays reusable.

## Architecture

```text
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
```

The realtime voice path stays thin. Slow web search, browser work, long reasoning and automation are delegated instead of blocking microphone/speaker streaming.

## Provider strategy

- Voice: Gemini Live is implemented; GPT-Live, Pipecat-backed runtimes, and a cheap chained STT -> brain -> TTS path are planned behind the same contract.
- Brain: any OpenAI-compatible endpoint; DeepSeek, Hermes, OpenRouter and local gateways can share one adapter.
- Actions: provider-neutral routing/cancellation; the first physical-device tools execute through the firmware's MCP compatibility layer.
- Agent/tools: Hermes Agent is optional and can run on a VPS or managed service.
- Search: Hermes, SearXNG, DDGS, Brave, provider-native search, or future adapters.
- Memory: start local; PostgreSQL/pgvector can be added when deployment needs it.
- Device: first target is Waveshare ESP32-S3-Touch-LCD-1.85B through the standalone `nara-firmware` repository.

## Project continuity

The repository is the durable source of truth for project direction rather than chat history.

Start with:

- `AGENTS.md`
- `docs/REPO_MAP.md`
- `docs/PROJECT_STATE.md`

Personal/multi-person memory design lives in `docs/PERSONAL_KNOWLEDGE.md`. Offline-first behavior lives in `docs/OFFLINE_RUNTIME.md`. Hardware purchase/test state lives in `docs/HARDWARE_PLAN.md`. Durable architectural choices live in `docs/DECISIONS.md`.

Real personal knowledge is runtime-private and must never be committed to this public repository.

## Deployment

Nara does not assume a permanent host. It can run on a laptop, home server, generic VPS, SumoPod, or another container platform.

## Status

Nara's software core is now a real end-to-end system rather than an architecture sketch.

The physical realtime voice path supports firmware WebSocket/Opus framing, session-scoped Opus/PCM transcoding, Gemini Live, provider-neutral voice-session contracts, connect-time fallback, bounded playback pacing, interruption/barge-in lifecycle, tool calls and usage/token accounting. Automated coverage includes a real-Opus firmware-to-provider round trip.

The Action Runtime can execute compact, validated tools without exposing firmware-specific MCP details to the model. Implemented capabilities include device status/volume, physical-reflex customization, privacy-filtered personal-memory retrieval and Spotify playback/search/control. Server-side tools continue to work even when a firmware MCP tool is not involved.

Identity and memory have fail-closed boundaries. Devices have a persistent claim/credential lifecycle with rotation and revocation. Personal facts are subject/viewer-aware, validated before persistence and filtered before model context. Realtime voice deliberately remains guest/public-scoped until a strong authenticated human viewer is bound to the session; speaker recognition is personalization evidence, not root authorization.

The standalone Waveshare 1.85B firmware builds in CI and includes Nara's parametric face, local audio-driven mouth motion, touch/IMU physical reflexes, flip/shake/spin classifiers, persistent custom reaction packs, private local reaction-sound assets, battery-gauge policy, Wi-Fi saved-network recovery, useful no-network idle behavior and an authenticated OTA path. Custom reaction sounds can be updated through the separate asset partition rather than rebuilding gesture behavior.

A separate authenticated browser phone-audio bridge is also implemented. A phone can provide microphone/audio output to the same provider-neutral voice runtime; when a TWS headset is routed through the phone OS, the browser path can use that phone/TWS audio route. The phone credential is isolated from firmware credentials and does not automatically grant private-memory access.

Optional external local vision for the Waveshare target is implemented and merged in Nara Firmware. It uses a small ESP-IDF-native SSCMA I2C adapter so a compatible external vision module can return compact local detection boxes; only normalized gaze coordinates drive Nara's eyes, without streaming ordinary tracking frames to the LLM.

What remains cannot be truthfully marked complete from CI alone: physical microphone/AEC/speaker tuning, real gesture threshold calibration in the final enclosure, battery-life measurements, phone/TWS browser validation on target devices, and external-camera field-of-view/orientation calibration. Product-layer work that is still intentionally staged includes strong human/passkey authentication for private-memory privilege, richer isolated-device utilities/capsule UX, production commissioning migration and optional additional voice/search/delegation providers.
