# Architecture

Treat the physical device as a replaceable body and cloud/local services as replaceable capabilities.

## Runtime layers
1. Device: mic, speaker, display, touch, IMU, AEC/VAD and local animation.
2. Gateway: authenticated WebSocket/audio transport, session state and interruption.
3. Voice: native live voice provider or chained STT/TTS.
4. Brain: reasoning, tool planning and structured decisions.
5. Character: profile, style, emotion policy and memory rules.
6. Actions: provider-neutral ToolProvider routing, cancellation and policy.
7. Tools: device MCP, search, browser, reminders, external MCP and agent delegation.
8. Memory: durable recall independent from the selected model.

## Why Hermes is optional
Hermes is useful as an always-on VPS agent because it exposes an OpenAI-compatible API and can own web/browser/tools. It should not sit inside every raw audio frame. Voice delegates a task to Hermes while the live session stays responsive.

## Hardware independence
The protocol exposes semantic events such as `touch`, `imu`, `face.set`, `audio.interrupt` and `speech.started`, never Waveshare GPIO numbers.


## Action boundary

Voice and brain adapters never execute physical or external tools directly. They emit provider-neutral tool calls into the ActionRuntime. Device MCP is one adapter behind that boundary; future search, memory, Hermes and modern external MCP providers can join the same runtime without leaking their wire protocols into the voice path.

Speech interruption and tool-task cancellation are separate lifecycles.
