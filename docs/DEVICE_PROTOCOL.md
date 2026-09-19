# Firmware device protocol

This document describes the stable edge between `nara-firmware` and Nara Gateway.
Voice providers sit behind the gateway and must not leak into this wire protocol.

## Endpoint and authentication

Physical firmware connects to:

`ws(s)://<gateway>/device`

If `NARA_DEVICE_TOKEN` is configured, the gateway requires:

`Authorization: Bearer <token>`

The firmware already supports a runtime WebSocket token and prepends `Bearer ` when needed.
Prefer runtime provisioning/NVS over committing credentials into source.

## Session handshake

The firmware sends a JSON hello before any binary audio:

```json
{
  "type": "hello",
  "version": 1,
  "transport": "websocket",
  "features": { "mcp": true },
  "audio_params": {
    "format": "opus",
    "sample_rate": 16000,
    "channels": 1,
    "frame_duration": 60
  }
}
```

The gateway replies:

```json
{
  "type": "hello",
  "transport": "websocket",
  "session_id": "<uuid>",
  "audio_params": {
    "format": "opus",
    "sample_rate": 24000,
    "channels": 1,
    "frame_duration": 60
  }
}
```

The firmware waits for this response before considering the audio channel open.

The two directions are intentionally asymmetric: the device microphone stream is 16 kHz Opus, while the gateway playback stream defaults to 24 kHz. The Waveshare audio codec outputs at 24 kHz, and native-live providers such as Gemini also produce 24 kHz PCM, so this avoids an unnecessary playback resample.

## Binary Opus framing

The current firmware can speak three compatibility versions:

- v1: the WebSocket binary message is the raw Opus packet.
- v2: 16-byte big-endian header: version/u16, type/u16, reserved/u32, timestamp/u32, payload_size/u32, followed by Opus.
- v3: 4-byte header: type/u8, reserved/u8, payload_size/u16 big-endian, followed by Opus.

Binary audio before a valid firmware hello is a protocol error.

The gateway parser validates header version/type/length before exposing an Opus payload to the future voice runtime.

## Control JSON

Firmware currently sends compatibility messages such as `listen`, `abort`, and `mcp`.
Firmware currently accepts compatibility messages such as `tts`, `stt`, `llm`, `mcp`, `system`, and `alert`.

The physical playback lifecycle has one strict ordering rule: the gateway sends `{"type":"tts","state":"start"}` before the first binary playback packet. The current firmware only accepts incoming audio while its state machine is in `Speaking`; sending binary audio first would silently discard it.

At provider turn completion the gateway:
1. flushes any PCM shorter than one 60 ms device frame by padding the rest with silence;
2. sends all resulting Opus packets through the playback pacer;
3. waits until the gateway pacing queue is drained;
4. sends `{"type":"tts","state":"stop"}`.

The stop message means the gateway has finished transmitting the response. In auto-listening mode the firmware already waits for its local playback queue to drain before re-enabling voice processing, so the gateway does not need to guess physical speaker completion.

For interruption, firmware `abort` immediately clears queued gateway playback, resets the downlink codec state, and receives `tts/stop`. Provider output from the old turn is suppressed until the provider confirms interruption or the old turn naturally completes.

A manual `listen/stop` is translated to the provider-neutral `VoiceSession.endAudioStream()`. Gemini maps that to `realtimeInput.audioStreamEnd=true`, which is the documented signal for a microphone stream ending while automatic activity detection remains enabled.

These are edge-format details. Nara core translates them into hardware-neutral session events rather than teaching Gemini/GPT/other providers about XiaoZhi-era message names.

## Frame duration

The first hardware baseline stays at 60 ms because that is what the current firmware encoder and queues already use.

Playback is rate-controlled because the firmware decode queue is deliberately small. Nara currently follows the proven compatibility pattern of sending the first five 60 ms packets immediately as a short prebuffer and then pacing remaining packets at one packet per 60 ms. This prevents a realtime provider that generates faster than playback speed from flooding the ESP32 decode queue.

Opus supports shorter frames and RFC 6716 notes that 20 ms is a good general choice for interactive applications. Nara should benchmark 20/40/60 ms end-to-end after the voice path is functional rather than changing packetization during the transport bring-up.

## Virtual device

The browser virtual device remains a lightweight semantic-protocol client. It shares `/device` for development, but it is not intended to emulate binary audio or replace the real firmware integration tests.
