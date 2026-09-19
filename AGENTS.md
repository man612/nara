# AGENTS.md

## Mission
Build a provider-agnostic core for physical AI companions. No character, vendor, cloud, or hardware provider may become a hard dependency unless explicitly justified.

## Architectural rules
- "doi" is a profile, never a core concept.
- Keep voice, brain, search, memory, tools, and device transport behind interfaces.
- Never put third-party API keys in ESP32 firmware.
- Keep low-latency audio transport separate from slow agent/tool work.
- Hermes may be an optional brain/tool backend, not a required runtime.
- Prefer one OpenAI-compatible brain adapter for DeepSeek, OpenRouter, Hermes, vLLM, Ollama and similar endpoints.
- Device messages must be versioned and hardware-neutral.
- Hardware-specific behavior belongs in firmware, not this repo.
- Blink, gaze, lip-sync, idle animation, touch and IMU reactions should be deterministic local behaviors where possible.

## Development
Run `npm install`, `npm run check`, `npm test`, then `npm run dev`.

Never commit `.env`, credentials, recordings, or personal memory data.
