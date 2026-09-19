# Voice runtimes

The device transport and the voice runtime are deliberately separate.

## Stable device edge

ESP32-class devices connect to Nara Gateway over a small authenticated WebSocket/audio protocol. The first firmware target can reuse efficient Opus framing while the server translates to whichever voice runtime is active.

Changing voice providers must not require reflashing the device.

The gateway codec boundary is session-scoped: each physical connection owns its own Opus decoder, playback encoder, and partial PCM buffer. Provider PCM chunks are packetized independently from firmware framing so provider chunk duration never leaks into the device protocol.

## Native realtime voice

Native speech-to-speech providers are the preferred path when low latency, barge-in and natural turn taking matter.

Initial adapters:
- Gemini Live
- GPT-Live

The first implemented native adapter is Gemini Live. It uses the documented raw v1beta WebSocket edge rather than exposing a provider SDK to the rest of Nara.

Current Gemini baseline:
- model: `gemini-3.8-live`;
- device/gateway PCM input: 16-bit little-endian mono at 16 kHz;
- model audio output: 16-bit little-endian mono at 24 kHz;
- response modality: audio;
- automatic activity detection remains enabled so start-of-activity performs the provider's default barge-in behavior;
- context-window compression uses the provider sliding-window mechanism;
- session resumption is enabled and the latest resumable handle is retained;
- a GoAway message starts a replacement WebSocket using that resumable handle;
- input/output transcription is opt-in to avoid unnecessary text generation/usage when the UI does not need it.

The adapter uses the existing `ws` dependency. The raw protocol is intentionally contained inside `src/providers/voice/gemini-live.ts`, so moving to the Google SDK later would not affect the device or codec contracts.

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
