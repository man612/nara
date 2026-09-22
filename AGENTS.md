# AGENTS.md

## Mission

Build Nara as a provider-neutral runtime for expressive physical AI. No character, vendor, cloud, hosting service, voice stack, or hardware platform may become a hard dependency unless explicitly justified.

## Read efficiently

Before broad exploration:
1. read `docs/REPO_MAP.md`;
2. read `docs/PROJECT_STATE.md` for the current checkpoint, next milestone, blockers, and hardware state;
3. read only the focused design doc relevant to the issue;
4. use `rg`/targeted search before opening large files;
5. avoid scanning `nara-firmware` when a task is server-only, and vice versa.

Do not spend agent context rediscovering decisions recorded in `docs/`. Do not rely on chat history as the only record of project direction.

## Architectural rules

- "doi"/partner is a profile, never a core concept.
- The first partner-focused deployment must not prevent future multi-person use.
- Keep companion identity, human/person profiles, durable personal memory, and project-development instructions separate.
- Personal memory must be subject-aware and viewer-aware.
- Filter unauthorized personal facts before they enter model context.
- Unknown viewers default to least privilege.
- Never commit real names/biographies/private relationship context, recordings, credentials, or personal memory data to this public repository.
- Use role aliases such as `owner`, `partner`, and `guest` in public examples/tests.
- Keep voice, brain, search, memory, tools, and device transport behind interfaces.
- Internet loss must degrade capabilities, not make the physical companion useless; read `docs/OFFLINE_RUNTIME.md` for offline capability levels.
- Keep connectivity state separate from interaction state. Temporary Wi-Fi loss must not be treated as permanent first-time setup.
- Do not promise unrestricted Indonesian STT/TTS on the ESP32-S3 alone; guaranteed offline interaction needs touch/button fallbacks.
- Offline personal capsules must contain only facts already authorized for that recipient/device.
- Never put third-party API keys in ESP32 firmware.
- Keep low-latency audio transport separate from slow agent/tool work.
- Hermes may be an optional brain/tool backend, not a required runtime.
- SumoPod, generic VPSes, home servers, and managed containers are deployment targets only.
- Prefer one OpenAI-compatible brain adapter for DeepSeek, OpenRouter, Hermes, vLLM, Ollama and similar endpoints.
- Device messages must be versioned and hardware-neutral.
- Hardware-specific behavior belongs in firmware, not this repo.
- Blink, gaze, lip-sync, idle animation, touch, and IMU reactions should be deterministic local behaviors where possible.
- Physical touch/motion reactions are local-first reflexes; do not send raw high-rate IMU/touch streams to an LLM or cloud by default. Read `docs/PHYSICAL_INTERACTIONS.md` before changing sensor behavior.
- Treat physical gestures as episodes with hysteresis/cooldowns so noisy samples do not repeatedly trigger speech or animation.
- Normalize provider usage before cost accounting; do not bake volatile prices into adapters.
- Keep stable prompt prefixes stable so provider caching can work.
- Do not send large memory/search/tool dumps to a model when a small structured subset is enough.
- Treat tool `effect` as an enforcement boundary: sensitive actions must stay hidden and fail closed unless an explicit session authorizer allows them; never infer approval from model text or speaker recognition.

## Durable project memory

After a meaningful implementation batch:

- update `docs/PROJECT_STATE.md` when completed/next/blocked state changed;
- add durable choices to `docs/DECISIONS.md`;
- add significant external findings to `docs/RESEARCH_SOURCES.md`;
- update `docs/HARDWARE_PLAN.md` when purchase/test state changes;
- keep README status truthful.

If a future coding agent cannot reconstruct why the next task exists from the repository, the repository context is incomplete.

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


## Repository ownership

- Nara-authored material is proprietary source-available software.
- Do not describe Nara as open source.
- Do not replace or weaken LICENSE without explicit owner instruction.
- Third-party material remains under its own license and must stay clearly
  separated from Nara's ownership claim.
- Unsolicited external contributions are not accepted by default; read
  CONTRIBUTING.md before merging third-party work.
