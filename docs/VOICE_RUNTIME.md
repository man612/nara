# Voice runtimes

The device transport and the voice runtime are deliberately separate.

## Stable device edge

ESP32-class devices connect to Nara Gateway over a small authenticated WebSocket/audio protocol. The first firmware target can reuse efficient Opus framing while the server translates to whichever voice runtime is active.

Changing voice providers must not require reflashing the device.

The gateway codec boundary is session-scoped: each physical connection owns its own Opus decoder, playback encoder, and partial PCM buffer. Provider PCM chunks are packetized independently from firmware framing so provider chunk duration never leaks into the device protocol.

## Native realtime voice

Native speech-to-speech providers are the preferred path when low latency, barge-in and natural turn taking matter.

Implemented production adapters:
- Gemini Live for native speech-to-speech.
- GPT-Live for native full-duplex speech with Responses delegation.
- Chained STT -> BrainProvider -> TTS for portable/cost-aware turn-based voice.

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

### GPT-Live

The GPT-Live adapter connects server-side to `/v1/live/sessions` and keeps the
OpenAI credential out of firmware. Nara deliberately configures mono PCM16 at
16 kHz, which GPT-Live supports directly and which matches the gateway uplink,
so the provider boundary does not require an extra input resample.

GPT-Live handles the spoken full-duplex conversation while a configured
Responses backend handles reasoning and Nara function tools. Function results
round-trip through `response.item.create` followed by `response.create`.
Typed/remote text uses the same delegated Responses input-item path.

Speech interruption only stops/suppresses spoken output. It does **not** cancel
pending Action Runtime work; tool cancellation remains an explicit, separate
lifecycle. Backend token usage and GPT-Live cumulative voice-session seconds
are reported separately because they are billed separately. Duplicate backend
completion usage is ignored by response ID.

GPT-Live does not expose a per-utterance audio-done event. Nara therefore uses
a short configurable output-idle boundary for its provider-neutral
`output.completed` event while the device playback queue remains the source
of truth for what has actually been played.

Each adapter implements the same `VoiceProvider` and `VoiceSession` contracts. Provider-specific event formats stop at the adapter boundary.

## Voice fallback

A configured route may contain a primary voice provider plus fallback providers.

Fallback happens both at initial connection and after a terminal provider
disconnect, with deliberately different safety rules.

At initial connection, Nara tries the configured providers in order. During an
active physical/phone session, provider-native recovery runs first (for example,
Gemini session resumption). Only when the provider reports terminal
`session.disconnected` does Nara mark that provider dead.

Cross-provider recovery is deferred until the **next user input**. Nara does
not replay the failed audio/text turn, copy half-finished model context, or
deliver late tool results into the replacement session. Pending identified
tool calls are cancelled through Action Runtime, stale provider events are
ignored by session generation, and active playback is interrupted. The next
input tries the next configured provider, wrapping around to the previous
provider last. A single-provider route therefore reconnects that provider.

Non-recoverable terminations (for example a provider safety/content terminal
reason) fail closed and are not silently bypassed by opening another provider.

This keeps the physical/phone session alive while treating provider
conversation context as disposable unless a provider has its own documented
resumption mechanism.

The example configuration activates Gemini Live by default. Both
`openai-live` and `chained` are implemented but opt-in: GPT-Live requires
OpenAI credentials/backend selection, while chained voice requires deliberate
STT/TTS endpoint selection. Either can be added to `voice.fallbacks` without
changing firmware.

## Chained voice

The implemented chained runtime is:

`PCM turn -> STT -> BrainProvider -> Action Runtime tools -> BrainProvider -> TTS -> PCM`

It buffers one bounded 16 kHz mono PCM turn, transcribes it, sends the text
through Nara's existing brain route, executes normalized tool calls through the
same server-side Action Runtime used by Gemini Live, and synthesizes the final
answer back to PCM. Search, memory and device tools therefore remain available
instead of being bypassed by the cheaper voice path.

STT/TTS use replaceable provider contracts. The first adapters target
OpenAI-compatible audio endpoints, so a deployment may point them at a hosted
service or a compatible local gateway. The brain remains Nara's configured
BrainProvider/fallback route.

Interruption aborts the active STT/brain/tool-wait/TTS turn through
`AbortSignal`. Input buffering, speech text and conversation history are
bounded. The runtime is turn-based, so it normally has more latency and less
natural overlap than native speech-to-speech, but it provides a practical
cost-aware and self-hostable foundation.

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
