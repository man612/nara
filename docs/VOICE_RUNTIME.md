# Voice runtimes

The device transport and the voice runtime are deliberately separate.

## Stable device edge

ESP32-class devices connect to Nara Gateway over a small authenticated WebSocket/audio protocol. The first firmware target can reuse efficient Opus framing while the server translates to whichever voice runtime is active.

Changing voice providers must not require reflashing the device.

## Native realtime voice

Native speech-to-speech providers are the preferred path when low latency, barge-in and natural turn taking matter.

Initial adapters:
- Gemini Live
- GPT-Live

Each adapter implements the same `VoiceProvider` and `VoiceSession` contracts. Provider-specific event formats stop at the adapter boundary.

## Chained voice

A chained runtime is:

`STT -> BrainProvider -> TTS`

This path is valuable for inexpensive or self-hosted deployments. It can mix local Whisper, hosted transcription, any configured brain, and local/free/hosted TTS.

It normally has more latency than native speech-to-speech but gives maximum portability.

## Optional framework runtimes

LiveKit Agents can be added as an adapter when WebRTC, browser/mobile clients, telephony or LiveKit infrastructure is useful.

Pipecat can be added as an adapter when its Python realtime pipeline ecosystem is useful, especially for chained STT/LLM/TTS experimentation. Pipecat also now maintains an ESP32-S3 client SDK using SmallWebRTC; that is a serious optional device-transport candidate, but it must be ported and measured on the Waveshare 1.85B before adoption.

Neither framework is a mandatory dependency of Companion Core. The device contract remains independent from WebSocket/Opus, SmallWebRTC/Pipecat, and LiveKit.

## Interruption

The core voice contract carries:
- incoming audio
- input/output transcripts
- speech start/stop
- interruption
- tool calls
- provider errors

AEC/VAD close to the device and interruption semantics in the voice adapter are both required for natural barge-in.
