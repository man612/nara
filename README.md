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

The physical realtime voice path is wired end-to-end at the gateway layer: firmware Opus framing, session-scoped Opus/PCM transcoding, a resumable Gemini Live adapter, bounded device playback pacing, interruption handling, provider-neutral session lifecycle, and connect-time voice-provider fallback routing are implemented and covered by automated tests including a real-Opus WebSocket vertical slice.

Nara also has a provider-neutral Action Runtime. Gemini Live can receive compact Nara tool declarations, emit tool calls, execute safe physical actions through the firmware's legacy MCP server, receive results, and cancel active calls by ID. The first device aliases cover status and speaker volume, with an end-to-end fake-ESP32 WebSocket integration test.

The standalone firmware also has the portable Nara face engine integrated into the Waveshare runtime.

The next architectural milestones are the local personal-memory/context vertical slice and an offline runtime foundation where loss of Internet degrades capabilities instead of making the companion useless. Hardware-in-the-loop voice/action validation, search, optional Hermes delegation, additional production voice adapters, and later in-session provider recovery follow.
