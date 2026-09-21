# Offline runtime strategy

Status: accepted product direction; implementation is staged.

Last reviewed: 2026-09-21

## Product requirement

Nara must not become useless when Internet connectivity disappears.

"Offline" has multiple meanings, so the runtime uses capability degradation rather than one binary online/offline flag.

The device should keep the most important local companion functions available, clearly indicate which capabilities are unavailable, and recover automatically when connectivity returns.

## Offline levels

### Level 0 — full online

Internet and the configured Nara Gateway/providers are reachable.

Available:

- normal realtime conversation;
- remote/cloud brain and voice providers;
- web/search/tools;
- full server-side personal memory;
- remote sync and updates.

### Level 1 — local network, no Internet

The device can reach a Nara Gateway or compatible local services on the same LAN, but the Internet is unavailable.

Target capability:

- local STT;
- local brain/LLM;
- local TTS;
- local personal memory;
- local Home Assistant/tools where applicable.

This can preserve nearly normal conversation if the household has a local compute node such as a PC, home server, NAS, or sufficiently capable SBC.

Provider boundaries already present in Nara are intended to make this possible without reflashing the ESP32.

### Level 2 — direct phone/local peer, no Internet

No normal LAN/Internet is required, but a phone can connect directly to Nara.

Preferred transports:

- Bluetooth LE for small control/status/pairing/sync messages;
- Nara-created Wi-Fi SoftAP for richer local web/data transfer.

ESP32-S3 supports Bluetooth LE but not Bluetooth Classic or LE Audio, so Bluetooth should not be treated as a general-purpose high-quality voice transport on this board.

A future native phone companion may optionally act as a local compute node, but that is not required for the first offline milestone.

### Level 3 — isolated device

No Internet, no LAN gateway, no tethering, no phone connection.

Nara must still provide useful local behavior.

## What should work on the device alone

### Always-local companion UX

- Nara face and local animations;
- touch interactions;
- IMU reactions;
- battery/device status;
- brightness and volume;
- local settings that do not require a server;
- explicit offline indicator that is informative but not alarming.

### Time functions

The Waveshare 1.85B includes a PCF85063 RTC.

Target local features:

- clock;
- timers;
- alarms;
- simple scheduled reminders already synchronized to the device;
- reconnect-time clock correction when network time becomes available.

### Offline gift/personal capsule

A recipient-focused device should carry a deliberately selected offline package rather than the entire private memory database.

Examples:

- shareable facts about the gift creator;
- short stories;
- notes/letters;
- important dates;
- selected photos/assets;
- pre-recorded audio messages;
- favorite quotes or inside-joke content;
- emergency/contact instructions if intentionally provided;
- pre-generated answers to common personal questions.

The capsule must contain only facts already allowed for that device/person. Owner-private facts must never be copied into the recipient's offline package.

Suggested package semantics:

```text
offline_capsule
  device_id
  recipient_person_id
  revision
  generated_at
  expires_at? / refresh policy
  facts[]
  messages[]
  media_manifest[]
  local_reminders[]
  search_aliases[]
  signature
```

The package is refreshed while online and remains readable offline.

### Offline memory lookup

Do not attempt a general LLM on the ESP32-S3.

Instead, the first local lookup engine should be deterministic and cheap:

- category navigation;
- normalized keyword matching;
- aliases/synonyms generated during online sync;
- small ranked/inverted index;
- pre-written or pre-generated answer templates.

Example:

```text
Rizma opens "Tentang Yasman"
  -> Hobi
  -> Teknologi
  -> "Yang paling sering dia kerjain apa?"
  -> local answer from authorized capsule
```

A direct-phone local UI may offer text search without Internet.

### Local media

Use flash for small core sounds/assets.

Use TF/microSD for larger offline content such as:

- photos;
- voice messages;
- local music/sounds;
- larger personal capsule assets;
- diagnostics/log export.

MicroSD is not required for the minimum firmware boot, but becomes strongly useful once the offline gift capsule is a real milestone.

### Offline audio self-test

The mic/speaker diagnostic path from `docs/AUDIO_ROBUSTNESS.md` should work without the network.

## What should not be promised on ESP32 alone

### Free-form Indonesian speech-to-text

ESP-SR MultiNet runs fully offline and supports up to 200 custom command words on ESP32-S3, but official support is Chinese and English.

Do not make unrestricted Indonesian offline speech recognition an acceptance criterion for the ESP32-only mode.

Indonesian command experiments may be tested, but the product must have touch/button alternatives.

### General Indonesian TTS from arbitrary text

ESP-SR's built-in TTS currently supports Chinese only.

For ESP32-only offline mode, use:

- screen text;
- tones/chimes;
- a curated set of recorded Indonesian phrases;
- pre-generated audio stored in flash/TF card.

### General conversational LLM

The ESP32-S3 target has 8 MB PSRAM and 16 MB flash.

Even a hypothetical 0.5 billion-parameter model quantized to 4 bits needs roughly 250 MB just for weights before runtime buffers/KV cache. Therefore a useful general conversational LLM is not a sensible first target on this MCU.

## Focused offline voice commands

ESP-SR MultiNet is still useful for a limited command layer.

Official properties include:

- fully offline command recognition;
- up to 200 commands;
- user-defined commands;
- low-resource operation;
- sub-500 ms recognition target;
- Chinese and English official command support.

Nara can use this for commands whose language/accuracy passes real-device tests.

Potential commands:

- stop/cancel;
- volume up/down;
- display brighter/dimmer;
- start audio test;
- show battery;
- open clock/timer mode.

For Indonesian-first UX, touch controls remain the guaranteed fallback until a validated Indonesian offline command solution exists.

## Local network brain

When a LAN compute node exists, Nara should be able to switch from cloud providers to local providers.

Reference architecture:

```text
ESP32 Nara
  |  local Wi-Fi
  v
Nara Gateway on local PC/server
  |-- local STT
  |-- local LLM
  |-- local TTS
  |-- local memory
  \-- local tools
```

Candidates worth benchmarking:

### STT

Whisper is multilingual and includes Indonesian. Home Assistant demonstrates Whisper behind a fully local Wyoming pipeline.

Other local engines such as sherpa-onnx are also provider candidates.

### Brain

Nara's OpenAI-compatible brain boundary can later point to a local runtime such as llama.cpp/Ollama/vLLM-compatible endpoints.

The exact local model is deployment-specific and should not leak into firmware.

### TTS

Home Assistant demonstrates local Piper TTS through Wyoming.

The original Rhasspy Piper repository was archived in 2025; the Open Home Foundation continuation `OHF-Voice/piper1-gpl` currently lists Bahasa Indonesia (`id_ID`) among supported languages.

Because that continuation is GPL-licensed, treat it as an optional external service and review redistribution/licensing before bundling it into a Nara distribution.

sherpa-onnx is another local TTS/provider candidate.

## Connection-state behavior

Network state must not be the same thing as device state.

Today the inherited firmware state machine effectively pushes a device without usable Wi-Fi toward `wifi_configuring`, and cloud conversation depends on a reachable gateway.

Nara should introduce an explicit local/offline capability state rather than trapping the product in setup mode.

Conceptually:

```text
connectivity:
  online
  local_gateway
  peer_only
  isolated

interaction:
  idle
  listening
  speaking
  local_menu
  notifying
  ...

capabilities:
  cloud_voice
  local_voice
  local_capsule
  web_search
  reminders
  ...
```

Connectivity should be orthogonal to the face/interaction state.

Example behavior:

```text
Wi-Fi lost
  -> finish/cancel network session safely
  -> show small offline indicator
  -> enable local menu/capsule/timers
  -> retry known networks in background
  -> recover online capabilities automatically
```

Do not repeatedly throw the recipient into Wi-Fi setup just because a known network is temporarily unavailable.

## Reconnect and sync

When connectivity returns:

- re-authenticate the device;
- reopen the configured gateway route;
- sync time;
- upload queued non-sensitive telemetry if allowed;
- refresh offline capsule/reminders;
- reconcile local changes;
- clear the offline indicator;
- do not interrupt an active local interaction unnecessarily.

Avoid queuing raw microphone audio for later upload by default.

## Security of offline data

Personal offline data is more exposed to physical theft than server-only data.

Production direction:

- per-device authorization remains enforced when creating the capsule;
- store only the recipient-authorized subset;
- use NVS encryption for small secrets/keys;
- evaluate ESP32-S3 flash encryption/secure boot for production;
- encrypt or application-wrap sensitive removable-storage content rather than assuming microSD is private;
- support remote/local revocation and wipe on transfer/reset;
- avoid placing owner-private facts on the recipient device at all.

ESP-IDF supports NVS encryption and flash encryption. Production enablement has lifecycle/debug implications and should be validated before fuses are permanently configured.

## Offline-first UX examples

### Internet disappears during normal use

```text
Nara:
"Internetnya lagi nggak ada. Aku tetap di sini kok."

screen:
Offline
Clock · Timer · Pesan · Tentang Yasman · Settings
```

Do not repeat the spoken message every reconnect cycle.

### Recipient asks for an unsupported cloud capability

```text
"Nah yang itu butuh internet. Tapi aku masih bisa buka pesan
yang tersimpan atau pasang timer."
```

### Offline personal content

Touch-driven first milestone:

```text
Tentang Yasman
  Work
  Hobbies
  Favorites
  Stories
  Messages
```

Later, if local Indonesian STT is available through a LAN/phone provider, natural speech can query the same capsule/provider-neutral memory interface.

## Implementation phases

### O0 — capability model

- separate network/connectivity status from interaction state;
- define offline capability flags;
- define reconnect policy;
- make no-network startup enter useful local mode rather than a dead end.

### O1 — local utility mode

- local clock;
- timer/alarm;
- battery/status;
- touch/button navigation;
- offline indicator;
- face/IMU behavior;
- audio diagnostics.

No microSD required.

### O2 — offline personal capsule

- schema/compiler on Nara backend;
- permission-filter before capsule creation;
- revision/signature;
- local read/search;
- notes/messages;
- pre-generated/recorded audio;
- microSD support for larger media.

### O3 — direct phone peer

- BLE GATT for status/control/small sync;
- SoftAP local web interface for larger transfers;
- optional phone compute experiment.

### O4 — local network voice stack

- local STT adapter;
- local brain adapter;
- local TTS adapter;
- automatic cloud/local routing;
- Indonesian benchmark.

### O5 — production security/power hardening

- encrypted local secrets;
- secure boot/flash-encryption manufacturing plan;
- removable-media protection;
- battery/offline longevity tuning.

## Acceptance criteria

Offline mode is real only when tests prove:

1. boot without Internet reaches a useful local UI;
2. temporary loss of Wi-Fi does not force factory-style onboarding;
3. clock/timer/alarm work without a server;
4. recipient-authorized capsule content remains readable offline;
5. owner-private facts are absent from the recipient capsule;
6. touch/button control works even when wake word/STT is unavailable;
7. cloud-only actions fail clearly without breaking local features;
8. reconnect restores network capability without rebooting;
9. local changes/sync conflicts are deterministic;
10. no raw conversation audio is silently queued for later upload;
11. direct BLE is not relied upon as Bluetooth audio on ESP32-S3;
12. a LAN local-brain path can be added without changing the ESP32 device protocol.

## Research references

- ESP-SR MultiNet command recognition:
  https://docs.espressif.com/projects/esp-sr/en/latest/esp32s3/speech_command_recognition/README.html
- ESP-SR overview / TTS language limitation:
  https://docs.espressif.com/projects/esp-sr/en/latest/esp32s3/getting_started/readme.html
- ESP-SR TTS:
  https://docs.espressif.com/projects/esp-sr/en/latest/esp32/speech_synthesis/readme.html
- Waveshare ESP32-S3-Touch-LCD-1.85B:
  https://docs.waveshare.com/ESP32-S3-Touch-LCD-1.85B
- ESP32-S3 BLE:
  https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/api-guides/ble/overview.html
- Espressif Bluetooth audio capability table:
  https://docs.espressif.com/projects/esp-adf/en/latest/solution-center/bluetooth-audio.html
- Home Assistant local Wyoming voice pipeline:
  https://www.home-assistant.io/integrations/wyoming
- Home Assistant fully local Assist:
  https://www.home-assistant.io/voice_control/voice_remote_local_assistant
- OpenAI Whisper:
  https://github.com/openai/whisper
- OHF Piper continuation:
  https://github.com/OHF-Voice/piper1-gpl
- sherpa-onnx:
  https://k2-fsa.github.io/sherpa/onnx/
- ESP-IDF NVS encryption:
  https://docs.espressif.com/projects/esp-idf/en/latest/esp32/api-reference/storage/nvs_encryption.html
- ESP32-S3 flash encryption:
  https://docs.espressif.com/projects/esp-idf/en/release-v5.5/esp32s3/security/flash-encryption.html
