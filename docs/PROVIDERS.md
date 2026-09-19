# Provider strategy

Provider choice is configuration, not architecture.

## Voice

- `openai-live`: native full-duplex GPT-Live adapter.
- `gemini-live`: native Gemini Live audio adapter.
- `chained`: STT -> brain -> TTS; cheapest/self-hostable path, normally less conversational.
- `mock`: deterministic test provider.

Native realtime providers and chained voice share the same `VoiceProvider` contract.

## Brain

Use `openai-compatible` wherever possible. The same adapter can cover DeepSeek, OpenRouter, Hermes API Server, vLLM, LM Studio, and compatible local gateways.

Provider model names and base URLs belong in configuration, never source code.

## Search and tools

Search is a separate capability so a voice or brain provider never forces its search vendor. Hermes, SearXNG, DDGS, Brave, and provider-native search can be adapters.

Hermes is an optional agent/tool backend. It can own browser automation, skills, search or cron work without being on the raw realtime audio path.

## Fallback

Each capability has an ordered provider chain. A primary provider can fail over without changing device firmware.

The initial brain chain demonstrates this directly:
`DeepSeek -> Hermes -> OpenRouter`.

## Deployment

SumoPod, a generic VPS, a home server, and managed container platforms are deployment presets only. Provider and deployment choices must not leak into the device protocol.
