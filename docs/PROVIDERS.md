# Provider strategy

Provider choice is configuration, not architecture.

## Voice
- `openai-live`: native full-duplex GPT-Live.
- `gemini-live`: native Gemini Live audio.
- `chained`: STT -> brain -> TTS; cheapest/self-hostable path, normally less conversational.
- `mock`: test provider.

## Brain
Use `openai-compatible` whenever possible. One adapter can cover DeepSeek, OpenRouter, Hermes API Server, vLLM, LM Studio and many Ollama-compatible setups.

Keep provider model names in configuration rather than source code.

## Search
Search is separate because a voice or brain model should not force the product to use its search vendor. Hermes, SearXNG, DDGS and Brave are candidate adapters.

## Fallback
Each capability gets an ordered provider chain. A premium provider can fail over to a cheaper provider without changing device firmware.
