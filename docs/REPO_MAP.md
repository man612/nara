# Repository map

Read this before broad code search.

## Runtime entry

- `src/index.ts` — HTTP/WebSocket gateway bootstrap. Keep it thin.
- `src/contracts/device.ts` — hardware-neutral semantic device messages.
- `src/contracts/providers.ts` — voice/brain/search/memory contracts and normalized usage.
- `src/provider-registry.ts` — provider construction and fallback composition.

## Configuration

- `config/providers.example.yaml` — provider routing example.
- `config/profiles/default.yaml` — generic character profile.
- `config/profiles/doi.example.yaml` — example partner profile; never make this a core dependency.
- `.env.example` — server-side secrets and model overrides.

## Providers

- `src/providers/brain/openai-compatible.ts` — common text brain adapter for compatible APIs.
- `src/providers/brain/fallback.ts` — ordered fallback chain.
- `src/providers/voice/` — realtime/chained voice adapters belong here.

## Device development

- `virtual-device/index.html` — lightweight protocol/dev console, not the final embedded renderer.
- Nara's production face renderer belongs in `nara-firmware` and should be simulatable on desktop with LVGL.

## Deployment

- `deploy/compose.yaml` — generic Docker deployment.
- `deploy/presets/sumopod.md` — optional hosting note, not a platform dependency.

## Focused design docs

- `docs/ARCHITECTURE.md` — system boundaries.
- `docs/PROVIDERS.md` — provider strategy.
- `docs/VOICE_RUNTIME.md` — realtime voice/runtime choices.
- `docs/COST_EFFICIENCY.md` — token/API cost rules.
- `docs/RESEARCH_SOURCES.md` — external codebases evaluated and license constraints.

## Tests

- `tests/provider-contracts.test.ts`
- `tests/provider-config.test.ts`
- `tests/provider-usage.test.ts`
- `tests/fallback-brain.test.ts`

Agents should inspect only the files relevant to the current issue before expanding scope.
