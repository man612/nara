# Repository map

Read this before broad code search.

## Durable project context

- `docs/PROJECT_STATE.md` — canonical checkpoint: what is real, what is next, blockers, and update discipline.
- `docs/DECISIONS.md` — compact durable architecture/product decision log.
- `docs/HARDWARE_PLAN.md` — what physical hardware is targeted, what to buy, and when.
- `docs/PERSONAL_KNOWLEDGE.md` — multi-person/private-memory architecture and access rules.
- `docs/PERSONAL_PROFILE_TEMPLATE.md` — template for future private owner onboarding; never commit a filled real profile.
- `docs/ONBOARDING_IDENTITY.md` — research-backed proposal for first-use gift claiming, account/device identity, secure pairing, Wi-Fi provisioning, voice identity, recovery, and transfer.
- `docs/AUDIO_ROBUSTNESS.md` — hardware/audio audit, fail-soft voice identity, fallback UX, diagnostics, and hardware-in-the-loop test plan.
- `docs/OFFLINE_RUNTIME.md` — offline capability levels, isolated-device utilities, local personal capsule, local-network voice, reconnect, and security strategy.
- `docs/PHYSICAL_INTERACTIONS.md` — CST816S/QMI8658 capabilities, local reflex architecture, gesture classifiers, reaction policy, and hardware validation.
- `docs/PHONE_CONNECTIVITY.md` — phone hotspot, direct SoftAP peer mode, BLE/DPP provisioning roles, capability states, security, and implementation order.
- `docs/RESEARCH_SOURCES.md` — external projects evaluated, useful ideas, licenses, and decisions.

## Runtime entry

- `src/index.ts` — process/bootstrap entry only. Keep it thin.
- `src/gateway.ts` — HTTP/WebSocket server, firmware/semantic session handshake and device-edge hooks.
- `src/contracts/device.ts` — hardware-neutral semantic device messages.
- `src/contracts/connectivity.ts` — cloud/local-gateway/direct-peer/isolated capability model and provisioning/runtime transport vocabulary.
- `src/contracts/providers.ts` — voice/brain/search/memory contracts and normalized usage.
- `src/provider-registry.ts` — provider construction and fallback composition.

## Personal memory

- `src/memory/personal.ts` — validated local personal-memory adapter: subject/viewer-aware access filtering, bounded lexical recall, expiry, edit/delete, and versioned file persistence.
- `src/memory/context.ts` — access-filtered context composer and text-path brain service; raw storage must not be concatenated into prompts.
- `src/memory/tool-provider.ts` — viewer/subject-bound realtime memory search tool; identity parameters are fixed server-side rather than supplied by the model.
- `src/identity/people.ts` — least-privilege viewer resolver; authenticated/verified identities may resolve, speaker guesses alone remain guest.
- `tests/personal-memory.test.ts`
- `tests/device-mcp-tools.test.ts`
- `tests/phone-protocol.test.ts`
- `tests/phone-gateway.integration.test.ts`
- `tests/media-tool-provider.test.ts`
- `tests/spotify-provider.test.ts`
- `tests/speaker-identity.test.ts`
- `tests/speaker-turn.test.ts`
- `tests/ota-http.test.ts` — privacy, partner/guest, persistence, expiry, edit/delete, and recall-limit coverage.
- `tests/memory-context.test.ts` — persisted-record validation, viewer-resolution and provider-capture proof that unauthorized facts never enter model requests.
- `tests/memory-tool-provider.test.ts` — realtime memory tool binding, response minimization and query validation.
- `data/` — intended runtime-private state boundary; gitignored and never a source file directory.

The current file adapter is a replaceable first implementation, not permission to bypass the memory boundary elsewhere.

## Device edge

- `src/device/registry.ts` — persistent device lifecycle registry, one-time claim transactions, hashed per-device credentials, rotation/revocation and authorization helpers.
- `src/device/firmware-wire.ts` — physical firmware hello/auth helpers and WebSocket Opus v1/v2/v3 framing.
- `src/device/audio-pacer.ts` — bounded 60 ms playback pacing with a short prebuffer.
- `src/device/voice-bridge.ts` — per-device firmware ↔ codec ↔ VoiceSession lifecycle bridge.
- `src/device/mcp-tools.ts` — compact validated aliases over firmware MCP, including device status/volume and local-reflex customization.
- `src/phone/protocol.ts` — bounded PCM16 framing for the authenticated browser phone-audio path.
- `src/phone/voice-bridge.ts` — phone/browser ↔ provider-neutral VoiceSession bridge.
- `phone-bridge/index.html` — browser mic/playback client; phone OS routing may use a connected TWS.
- `src/media/spotify.ts` — Spotify Web API implementation.
- `src/media/tool-provider.ts` — compact provider-neutral media actions.
- `src/audio/codec.ts` — stable session-scoped audio codec interfaces.
- `src/audio/streaming-opus.ts` — PCM16 frame accumulation and provider↔device streaming codec glue.
- `src/audio/libopus-wasm.ts` — first production Opus primitive implementation; package/platform details stay behind the codec boundary.
- `docs/DEVICE_PROTOCOL.md` — stable firmware↔gateway wire contract and compatibility notes.
- `virtual-device/index.html` — lightweight semantic protocol/dev console; it is not a binary-audio firmware emulator.

## Identity, media and updates

- `src/identity/directory.ts` / `src/identity/file-directory.ts` — runtime-private person directory boundary.
- `src/identity/speaker.ts` / `src/identity/speaker-turn.ts` — conservative speaker-identification decision/session layer; never root auth.
- `src/ota/catalog.ts` — GitHub Releases-backed OTA catalog.
- `src/ota/channels.ts` — per-device stable/beta update channel policy.
- `src/ota/http.ts` — firmware-compatible authenticated OTA HTTP surface.
- `src/content/personal-content.ts` / `src/content/http.ts` — scoped personal-content authoring surface.

## Configuration

- `config/providers.example.yaml` — provider routing example.
- `config/profiles/default.yaml` — generic character profile.
- `config/profiles/doi.example.yaml` — example partner profile; never make this a core dependency.
- `.env.example` — server-side secrets, model overrides, and optional device bearer credential.

## Providers

- `src/providers/brain/openai-compatible.ts` — common text brain adapter for compatible APIs.
- `src/providers/brain/fallback.ts` — ordered fallback chain.
- `src/providers/voice/gemini-live.ts` — raw Gemini Live v1beta provider adapter, usage normalization and session resumption.
- `src/providers/voice/` — other realtime/chained voice adapters belong here.

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
- `docs/PERSONAL_KNOWLEDGE.md` — private personal-memory and multi-person access model.
- `docs/ONBOARDING_IDENTITY.md` — device claim, human authentication, provisioning, speaker identity, and lifecycle design.
- `docs/AUDIO_ROBUSTNESS.md` — mic/speaker/AEC robustness, voice identity fallback, diagnostics, and HIL audio validation.
- `docs/OFFLINE_RUNTIME.md` — offline-first behavior, local capsule, peer mode, local voice provider path, and reconnect rules.
- `docs/PHYSICAL_INTERACTIONS.md` — touch/motion reflexes, petting/shake/upside-down behavior, classifier boundaries, and local personality rules.
- `docs/PHONE_CONNECTIVITY.md` — phone commissioning, tethering, direct local access, BLE lifecycle, DPP and local-web strategy.

## Tests

- `tests/device-contracts.test.ts`
- `tests/device-registry.test.ts`
- `tests/device-auth.integration.test.ts`
- `tests/connectivity-contracts.test.ts`
- `tests/firmware-wire.test.ts`
- `tests/gateway-firmware.integration.test.ts`
- `tests/audio-codec.test.ts`
- `tests/libopus-wasm.test.ts`
- `tests/gemini-live.test.ts`
- `tests/audio-pacer.test.ts`
- `tests/voice-bridge.test.ts`
- `tests/firmware-voice.integration.test.ts`
- `tests/provider-contracts.test.ts`
- `tests/provider-config.test.ts`
- `tests/provider-usage.test.ts`
- `tests/fallback-brain.test.ts`
- `tests/personal-memory.test.ts`

Agents should inspect only the files relevant to the current issue before expanding scope.
