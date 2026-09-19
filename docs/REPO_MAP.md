# Repository map

Read this before broad code search.

## Runtime entry

- `src/index.ts` — process/bootstrap entry only. Keep it thin.
- `src/gateway.ts` — HTTP/WebSocket server, firmware/semantic session handshake and device-edge hooks.
- `src/contracts/device.ts` — hardware-neutral semantic device messages.
- `src/contracts/providers.ts` — voice/brain/search/memory contracts and normalized usage.
- `src/provider-registry.ts` — provider construction and fallback composition.

## Device edge

- `src/device/firmware-wire.ts` — physical firmware hello/auth helpers and WebSocket Opus v1/v2/v3 framing.
- `src/audio/codec.ts` — stable session-scoped audio codec interfaces.
- `src/audio/streaming-opus.ts` — PCM16 frame accumulation and provider↔device streaming codec glue.
- `docs/DEVICE_PROTOCOL.md` — stable firmware↔gateway wire contract and compatibility notes.
- `virtual-device/index.html` — lightweight semantic protocol/dev console; it is not a binary-audio firmware emulator.

## Configuration

- `config/providers.example.yaml` — provider routing example.
- `config/profiles/default.yaml` — generic character profile.
- `config/profiles/doi.example.yaml` — example partner profile; never make this a core dependency.
- `.env.example` — server-side secrets, model overrides, and optional device bearer credential.

## Providers

- `src/providers/brain/openai-compatible.ts` — common text brain adapter for compatible APIs.
- `src/providers/brain/fallback.ts` — ordered fallback chain.
- `src/providers/voice/` — realtime/chained voice adapters belong here.

## Device development

- Nara's production face renderer belongs in `nara-firmware` and should be simulatable on desktop with LVGL.
- Keep provider-specific realtime events behind gateway adapters; ESP32 should only know the stable device edge.

## Deployment

- `deploy/compose.yaml` — generic Docker deployment.
- `deploy/presets/sumopod.md` — optional hosting note, not a platform dependency.

## Focused design docs

- `docs/ARCHITECTURE.md` — system boundaries.
- `docs/DEVICE_PROTOCOL.md` — physical firmware transport.
- `docs/AUDIO_CODEC.md` — Opus/PCM boundary, buffering, interruption, and implementation replacement.
- `docs/PROVIDERS.md` — provider strategy.
- `docs/VOICE_RUNTIME.md` — realtime voice/runtime choices.
- `docs/COST_EFFICIENCY.md` — token/API cost rules.
- `docs/RESEARCH_SOURCES.md` — external codebases evaluated and license constraints.

## Tests

- `tests/device-contracts.test.ts`
- `tests/firmware-wire.test.ts`
- `tests/gateway-firmware.integration.test.ts`
- `tests/audio-codec.test.ts`
- `tests/provider-contracts.test.ts`
- `tests/provider-config.test.ts`
- `tests/provider-usage.test.ts`
- `tests/fallback-brain.test.ts`

Agents should inspect only the files relevant to the current issue before expanding scope.
