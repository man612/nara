# AGENTS.md

## Mission

Build Nara as a provider-neutral runtime for expressive physical AI. No character, vendor, cloud, hosting service, voice stack, or hardware platform may become a hard dependency unless explicitly justified.

## Read efficiently

Before broad exploration:
1. read `docs/REPO_MAP.md`;
2. read only the focused design doc relevant to the issue;
3. use `rg`/targeted search before opening large files;
4. avoid scanning `nara-firmware` when a task is server-only, and vice versa.

Do not spend agent context rediscovering decisions recorded in `docs/`.

## Architectural rules

- "doi" is a profile, never a core concept.
- Keep voice, brain, search, memory, tools, and device transport behind interfaces.
- Never put third-party API keys in ESP32 firmware.
- Keep low-latency audio transport separate from slow agent/tool work.
- Hermes may be an optional brain/tool backend, not a required runtime.
- SumoPod, generic VPSes, home servers, and managed containers are deployment targets only.
- Prefer one OpenAI-compatible brain adapter for DeepSeek, OpenRouter, Hermes, vLLM, Ollama and similar endpoints.
- Device messages must be versioned and hardware-neutral.
- Hardware-specific behavior belongs in firmware, not this repo.
- Blink, gaze, lip-sync, idle animation, touch, and IMU reactions should be deterministic local behaviors where possible.
- Normalize provider usage before cost accounting; do not bake volatile prices into adapters.
- Keep stable prompt prefixes stable so provider caching can work.
- Do not send large memory/search/tool dumps to a model when a small structured subset is enough.

## Development

Run:
- `pnpm install`
- `pnpm run check`
- `pnpm test`
- `pnpm run build`
- `pnpm run dev`

Before committing:
- type-check;
- run focused tests, then the full test suite;
- avoid unrelated refactors;
- never commit `.env`, credentials, recordings, or personal memory data.
