# companion-core

Provider-agnostic backend and virtual-device foundation for physical AI companions.

This project is intentionally **not tied to one character, LLM, voice provider, or hardware platform**. A partner/"doi" personality can be the first profile while the core stays reusable.

## Design

```text
physical / virtual device
        |
        | realtime device protocol
        v
companion gateway
   |        |         |
 voice     brain    character
   |        |         |
GPT Live   DeepSeek   profiles
Gemini     Hermes     emotion
chained    OpenRouter memory
           Ollama
        |
      tools
 search / browser / reminders / MCP
```

The real-time voice path stays thin. Slow web search, browser work, long reasoning and automation are delegated instead of blocking microphone/speaker streaming.

## Initial provider strategy

- Voice: Gemini Live, GPT-Live, or a cheap chained STT -> brain -> TTS pipeline.
- Brain: any OpenAI-compatible endpoint; DeepSeek is a first-class target.
- Agent/tools: Hermes Agent is optional and can run on a VPS.
- Search: Hermes, SearXNG, DDGS, Brave, or provider-native search.
- Memory: start local; PostgreSQL/pgvector can be added for deployment.
- Device: first target is Waveshare ESP32-S3-Touch-LCD-1.85B through the standalone `companion-firmware` repository.

## Status

The virtual device, semantic device protocol, provider contracts, configurable brain fallback chain, and deployment skeleton are in place. Next milestones are the real Gemini/GPT-Live adapters, chained voice, memory/search adapters, and the portable face engine.
