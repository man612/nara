# Voice runtimes

The device transport and the voice runtime are deliberately separate.

## Stable device edge

ESP32-class devices connect to Nara Gateway over a small authenticated WebSocket/audio protocol. The first firmware target can reuse efficient Opus framing while the server translates to whichever voice runtime is active.

Changing voice providers must not require reflashing the device.

The gateway codec boundary is session-scoped: each physical connection owns its own Opus decoder, playback encoder, and partial PCM buffer. Provider PCM chunks are packetized independently from firmware framing so provider chunk duration never leaks into the device protocol.

## Native realtime voice

Native speech-to-speech providers are the preferred path when low latency, barge-in and natural turn taking matter.

Implemented production adapter:
- Gemini Live.

Planned native adapter:
- GPT-Live.

The Gemini Live adapter uses the documented raw v1beta WebSocket edge rather than exposing a provider SDK to the rest of Nara.

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

## Voice fallback

A configured route may contain a primary voice provider plus fallback providers.

Fallback currently happens while opening a voice session: if the primary cannot be constructed or cannot connect, Nara tries the next configured provider. This is intentionally separate from in-session recovery. Once a realtime conversation has opened on one provider, Nara does not migrate that active conversation to a different provider yet.

The example configuration only activates Gemini Live because GPT-Live and chained voice are not implemented yet. A second implemented adapter can be added to `voice.fallbacks` without changing firmware.

## Chained voice

A chained runtime is:

`STT -> BrainProvider -> TTS`

This path is planned but not implemented yet. It is valuable for inexpensive or self-hosted deployments because it can mix local Whisper, hosted transcription, any configured brain, and local/free/hosted TTS.

It normally has more latency than native speech-to-speech but gives maximum portability.

## Optional framework runtimes

LiveKit Agents can be added as an adapter when WebRTC, browser/mobile clients, telephony or LiveKit infrastructure is useful.

Pipecat can be added as an adapter when its Python realtime pipeline ecosystem is useful, especially for chained STT/LLM/TTS experimentation. Pipecat also maintains an ESP32-S3 client SDK using SmallWebRTC; that is a serious optional device-transport candidate, but it must be ported and measured on the Waveshare 1.85B before adoption.

Neither framework is a mandatory dependency of Nara. The device contract remains independent from WebSocket/Opus, SmallWebRTC/Pipecat, and LiveKit.

## Interruption

The core voice contract carries:
- incoming audio
- input/output transcripts
- speech start/stop
- interruption
- tool calls
- provider errors

AEC/VAD close to the device and interruption semantics in the voice adapter are both required for natural barge-in.

## Physical firmware session bridge

The physical realtime path is assembled from replaceable boundaries:

```text
ESP32 microphone
    |
    | Opus 16 kHz mono / 60 ms
    v
Firmware WebSocket edge
    |
    v
AudioCodecSession
    |
    | PCM16LE 16 kHz
    v
VoiceSession
    |
    | PCM16LE 24 kHz
    v
AudioCodecSession
    |
    | Opus 24 kHz mono / 60 ms
    v
RealtimePacketPacer
    |
    v
ESP32 speaker
```

`FirmwareVoiceBridge` owns one codec session and one voice-provider session per physical WebSocket connection. Neither object is shared across devices.

The gateway serializes device messages per connection. This matters because a binary audio frame arriving immediately after hello must not overtake asynchronous provider/session initialization, and an abort must not race an earlier audio frame.

Provider output is also consumed serially. Playback starts only when the first complete Opus packet exists, then the bridge sends the firmware compatibility `tts/start` state before binary audio.

At normal turn completion, partial PCM is zero-padded to a final device frame, the gateway pacing queue drains, and then `tts/stop` is sent.

At local interruption, queued playback is dropped immediately and the encoder state is reset. With providers that use automatic VAD, stale output from the old generation is suppressed until the provider confirms interruption or the old generation completes. This prevents a late packet from re-entering speaking state after the user has already interrupted.

A manual microphone stop uses the optional provider-neutral `VoiceSession.endAudioStream()` capability. Providers that do not need it can omit it.

## Runtime configuration

Physical voice is enabled when `PROVIDERS_FILE` is set. The runtime loads the configured voice route, creates the codec factory, and attaches the bridge to physical firmware sessions.

Without `PROVIDERS_FILE`, Nara still starts in edge-only development mode: health checks and the virtual device remain available, but physical firmware audio is not connected to an AI provider.

For the example configuration:

```bash
cp config/providers.example.yaml config/providers.local.yaml
export PROVIDERS_FILE=config/providers.local.yaml
export GEMINI_API_KEY=...
pnpm start
```

Provider changes remain configuration-only. The firmware bridge only knows the `VoiceProvider` / `VoiceSession` contracts.
