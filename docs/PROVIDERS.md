# Provider strategy

Provider choice is configuration, not architecture.

## Voice

Implemented production adapters:

- `gemini-live`: native Gemini Live audio adapter.
- `chained`: bounded STT -> BrainProvider -> TTS turn runtime. It preserves
  Action Runtime tool calls and can use authenticated cloud endpoints or
  unauthenticated local OpenAI-compatible speech gateways.

Implemented speech adapters:

- `openai-compatible` STT: multipart WAV -> `/audio/transcriptions`.
- `openai-compatible` TTS: text -> raw PCM from `/audio/speech`.

Implemented test adapter:

- `mock`: deterministic test provider.

Planned adapters:

- `openai-live`: native full-duplex GPT-Live adapter.
- Pipecat-backed realtime pipelines where their ecosystem is useful.

Do not put planned adapter IDs into an active provider route until their adapter exists in `src/provider-registry.ts`.

Native realtime and chained voice share the same `VoiceProvider` contract.
Chained speech endpoints are deployment choices, not core dependencies.

## Brain

Use `openai-compatible` wherever possible. The same adapter can cover DeepSeek, OpenRouter, Hermes API Server, vLLM, LM Studio, and compatible local gateways.

Provider model names and base URLs belong in configuration, never source code.

## Search and tools

Search is a separate capability so a voice or brain provider never forces its search vendor.

Implemented production search adapter:

- `searxng`: JSON Search API adapter with request timeout, Action Runtime cancellation, bounded result count, moderate safe-search, and ordered fallback routing.

A configured search route is exposed as the compact `web_search` Action Runtime tool for firmware and phone voice sessions. If no `search:` route is configured, the tool is not added to the live schema.

Hermes remains an optional agent/tool backend for browser automation, skills, longer research or cron work without being on the raw realtime audio path. DDGS, Brave and provider-native search can be added behind the same `SearchProvider` contract later.

## Fallback

Brain providers use an ordered request-time fallback chain.

Voice providers now use an ordered connect-time fallback chain. When a configured voice provider cannot be constructed or cannot open a session, Nara tries the next configured voice provider. A successfully opened realtime session is not migrated to another provider in the middle of a conversation yet.

Only configure fallback IDs whose adapters are actually implemented. The example configuration keeps voice fallbacks empty by default so deployments explicitly choose STT/TTS endpoints before enabling the implemented `chained` route.

## Deployment

SumoPod, a generic VPS, a home server, and managed container platforms are deployment presets only. Provider and deployment choices must not leak into the device protocol.
