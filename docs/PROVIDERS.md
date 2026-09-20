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

Search is a separate capability so a voice or brain provider never forces its search vendor. Hermes, SearXNG, DDGS, Brave, and provider-native search can be adapters.

Hermes is an optional agent/tool backend. It can own browser automation, skills, search or cron work without being on the raw realtime audio path.

These search/tool adapters are architectural targets; they are not wired into the production runtime yet.

## Fallback

Brain providers use an ordered request-time fallback chain.

Voice providers now use an ordered connect-time fallback chain. When a configured voice provider cannot be constructed or cannot open a session, Nara tries the next configured voice provider. A successfully opened realtime session is not migrated to another provider in the middle of a conversation yet.

Only configure fallback IDs whose adapters are actually implemented. The example configuration intentionally leaves voice fallbacks empty until a second production voice adapter lands.

## Deployment

SumoPod, a generic VPS, a home server, and managed container platforms are deployment presets only. Provider and deployment choices must not leak into the device protocol.
