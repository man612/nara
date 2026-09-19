# Nara

**Open runtime for expressive physical AI.**

Nara is a provider-neutral runtime for building small physical AI companions that can listen, speak, reason, remember, use tools, and drive a local expressive interface.

It is intentionally not tied to one character, one model provider, one voice stack, or one hardware platform. A partner/"doi" personality can be the first profile while the runtime stays reusable.

## Architecture

```text
physical / virtual device
        |
        | realtime device protocol
        v
      Nara Gateway
   |        |         |
 voice     brain    character
   |        |         |
GPT Live   DeepSeek   profiles
Gemini     Hermes     emotion
chained    OpenRouter memory
Pipecat    local LLM
        |
      tools
 search / browser / reminders / MCP
```

The realtime voice path stays thin. Slow web search, browser work, long reasoning and automation are delegated instead of blocking microphone/speaker streaming.

## Provider strategy

- Voice: Gemini Live, GPT-Live, Pipecat-backed runtimes, or a cheap chained STT -> brain -> TTS path.
- Brain: any OpenAI-compatible endpoint; DeepSeek, Hermes, OpenRouter and local gateways can share one adapter.
- Agent/tools: Hermes Agent is optional and can run on a VPS or managed service.
- Search: Hermes, SearXNG, DDGS, Brave, provider-native search, or future adapters.
- Memory: start local; PostgreSQL/pgvector can be added when deployment needs it.
- Device: first target is Waveshare ESP32-S3-Touch-LCD-1.85B through the standalone `nara-firmware` repository.

## Deployment

Nara does not assume a permanent host. It can run on a laptop, home server, generic VPS, SumoPod, or another container platform.

## Status

The virtual device, semantic device protocol, provider contracts, configurable brain fallback chain, deployment skeleton, and hardware-independent firmware boundary are in place. Next milestones are production voice adapters, memory/search adapters, and the portable face engine.
