# Audio codec boundary

Nara keeps compressed device audio separate from provider audio.

## Why this boundary exists

The physical device should stay bandwidth-efficient and provider-agnostic, so it sends and receives Opus. Realtime AI providers generally consume and emit raw PCM instead.

That makes the gateway responsible for one narrow translation:

`device Opus <-> gateway PCM16 <-> VoiceProvider`

Provider adapters must never parse firmware framing, and firmware session code must never know Gemini/GPT event formats.

## Session scope

Opus encoder and decoder state is per physical-device session.

Do not share one decoder or encoder between connections. Opus decoding can depend on stream history, packet-loss concealment, FEC, and previous decoder state. Sharing that state would allow one device's audio history to affect another device.

This mirrors the safer pattern used by established Xiaozhi-compatible servers, which attach decoder state to each connection.

## Current stream contract

Uplink:

- device -> gateway
- Opus
- 16 kHz mono
- baseline packet duration: 60 ms
- decoder output: PCM16 little-endian at 16 kHz

Downlink:

- provider -> gateway
- PCM16 little-endian
- preferred rate: 24 kHz mono
- provider chunks may have arbitrary duration
- gateway accumulates PCM until one full 60 ms playback frame exists
- encoder outputs Opus at 24 kHz mono for the device

At 24 kHz mono PCM16, one 60 ms playback frame is 1,440 samples or 2,880 bytes.

## Interruption

Partial downlink PCM is disposable state.

On barge-in, abort, provider interruption, or a new response replacing the old one, call `resetDownlink()`. This drops incomplete PCM and resets the encoder when the underlying implementation supports it. Without that reset, the tail of the previous answer can be prepended to the next answer.

## Implementation replacement

`AudioCodecSession` is the stable interface.

The native/WASM package that implements `OpusDecoderPrimitive` and `OpusEncoderPrimitive` is replaceable. The first production implementation should be selected by platform coverage, maintenance, correctness tests, deployment behavior, and measured latency rather than package popularity alone.

The current candidate research includes:

- `libopus-node`: modern N-API wrapper, extensive platform CI including Linux glibc/musl x64+arm64, but still a young package.
- `@discordjs/opus`: mature and widely deployed native libopus wrapper with Node >=20 support and prebuilt releases.
- WASM implementations: useful fallback when native deployment is undesirable, but should be benchmarked under Nara's actual 16/24 kHz mono workload.

Keep the dependency behind this interface so changing the implementation never affects firmware or provider contracts.
