# Provider strategy

Provider choice is configuration, not architecture.

## Voice

Implemented production adapter:

- `gemini-live`: native Gemini Live audio adapter.

Implemented test adapter:

- `mock`: deterministic test provider.

Planned adapters:

- `openai-live`: native full-duplex GPT-Live adapter.
- `chained`: STT -> brain -> TTS; inexpensive/self-hostable path, normally less conversational.
- Pipecat-backed realtime pipelines where their ecosystem is useful.

Do not put planned adapter IDs into an active provider route until their adapter exists in `src/provider-registry.ts`.

Native realtime providers and future chained voice share the same `VoiceProvider` contract.

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

Only configure fallback IDs whose adapters are actually implemented. The example configuration intentionally leaves voice fallbacks empty until a second production voice adapter lands.

## Deployment

SumoPod, a generic VPS, a home server, and managed container platforms are deployment presets only. Provider and deployment choices must not leak into the device protocol.
