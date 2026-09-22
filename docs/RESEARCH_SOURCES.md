# Research sources and reuse policy

This is a compact record so future contributors and coding agents do not repeat the same research.


## SSCMA local vision / Grove Vision AI Module V2

Purpose: add optional local person/object-following gaze without pretending the base Waveshare board has an onboard camera or continuously uploading camera frames to an LLM.

Useful findings:

- Seeed's SSCMA Arduino reference uses default I2C address `0x62`;
- the protocol supports an `INVOKE` command and compact detection outputs such as boxes/classes/points;
- detection boxes expose center coordinates plus size, score and target ID;
- the Waveshare 1.85B exposes the shared I2C bus used by onboard peripherals, and the researched SSCMA default address does not collide with the currently used onboard addresses;
- inference can remain on the external module while Nara consumes only compact coordinates.

Decision:

Nara uses a small ESP-IDF-native SSCMA I2C adapter rather than importing Arduino into the firmware. Ordinary eye tracking consumes local detection boxes, normalizes/smooths the best target and drives the face gaze API. Camera frames are not sent to the gateway/LLM merely to move the eyes.

Physical module choice, deployed model, power wiring, image coordinate dimensions, field of view and mounting orientation remain hardware-validation items.

References:

- https://github.com/Seeed-Studio/Seeed_Arduino_SSCMA
- https://wiki.seeedstudio.com/grove_vision_ai_v2/

## Hermes Agent / SOUL.md + USER.md + MEMORY.md

Purpose: reference for separating agent identity, user profile, learned memory, and project instructions.

Upstream: NousResearch/hermes-agent.

Useful ideas:

- `SOUL.md` is agent/instance identity and communication style, not a dump of user facts;
- `USER.md` and `MEMORY.md` are distinct from agent personality;
- `AGENTS.md`/project context remains project-specific;
- stable memory/context snapshots can help prompt-prefix caching;
- multiple profiles should have independent identity/memory/state.

Decision:

Adopt the conceptual separation, not Hermes' exact filesystem contract. Nara needs stronger multi-person semantics: personal facts have a subject and viewer/access policy, and unauthorized facts are filtered before LLM context construction. Hermes remains an optional backend/delegation target rather than a required runtime.

References:

- https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/which-file-does-what.md
- https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/personality.md
- https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/profiles.md

## XiaoZhi ESP32

Purpose: initial ESP32 board/audio/network foundation and Waveshare 1.85B support.

License: MIT.

Decision: Nara Firmware started from a pinned snapshot, then became a standalone repository. Keep attribution for inherited code and cherry-pick useful upstream fixes deliberately rather than mirroring upstream blindly.

## LVGL / lv_port_pc_vscode

Purpose: embedded face/UI renderer and desktop simulation.

License: MIT.

Useful ideas:
- run the same LVGL UI code on PC via SDL;
- keep Nara face rendering portable between desktop simulation and ESP32;
- pin the simulator to the same LVGL major/minor line as firmware.

Decision: preferred foundation for Nara Face.

## Espressif esp_emote_expression

Purpose: ESP-IDF expression/event/assets component.

License: Apache-2.0 according to its component manifest.

Useful ideas:
- explicit IDLE/SPEAK/LISTEN events;
- memory-mapped assets;
- display-resource lifecycle.

Decision: reference implementation, not the default Nara face engine. Nara prefers a lightweight parametric/vector face so expressions can combine continuously without large animation packs.

## Stack-chan

Purpose: mature social-robot behavior/UI reference.

License: Apache-2.0.

Useful ideas:
- face state is separate from rendering;
- eyes expose openness and gaze;
- mouth openness is a continuous value;
- emotion selects higher-level appearance;
- hardware capabilities are namespaced and semantic.

Decision: architecture reference. Do not import large sections unnecessarily.

## FluxGarage RoboEyes

Purpose: smooth robot-eye behavior reference.

License: GPL-3.0.

Useful ideas:
- randomized autoblink;
- randomized idle gaze;
- curiosity/flicker/laugh/confused as deterministic local animations.

Decision: **ideas only**. Do not copy its source into Nara because its GPL-3.0 licensing is intentionally stronger than Nara's inherited permissive firmware license.

## Pipecat / pipecat-esp32

Purpose: optional realtime voice pipeline and ESP32 SmallWebRTC transport.

License: MIT for pipecat-esp32.

Useful ideas:
- ESP32-S3 client;
- interruptible voice example;
- Linux target allows some hardware-free development.

Decision: maintain as a transport/runtime spike. Do not make Pipecat mandatory until measured on the Waveshare 1.85B.

## LiteLLM

Purpose: optional external multi-provider gateway.

License: most non-enterprise code is MIT; enterprise directory has separate terms.

Useful ideas:
- centralized spend/budget tracking;
- retries/fallbacks;
- unified OpenAI-style provider gateway.

Decision: do not add it to the minimum Nara deployment today. Nara already has a lightweight provider layer, and another always-on Python service would add RAM/operational cost on a small VPS. Re-evaluate if multi-user billing, dashboarding, or complex provider routing becomes valuable.

## ESP-SR AFE / microphone design / audio robustness

Purpose: audio-front-end baseline and hardware validation guidance for the first Waveshare device.

Useful findings:

- AEC, NS, VAD, WakeNet and multi-mic source separation are separate AFE capabilities and should be measured independently.
- Espressif recommends `AEC_MODE_FD_LOW_COST` as a general full-duplex performance/resource balance.
- AEC NLP aggressiveness trades residual-echo suppression against damage to near-end speech.
- microphone hole geometry, sealing, speaker isolation, array consistency, clipping, reference level and enclosure design materially affect recognition.
- Espressif distinguishes one-mic + reference (`MR`) from multi-mic AFE layouts in its benchmarks.

Nara-specific finding:

The current Nara 1.85B path derives `MR` from the generic `BoxAudioCodec` when playback reference is enabled, even though Waveshare advertises the board as dual-microphone. A recent XiaoZhi issue reports a related Waveshare 1.75 board needed board-specific ES7210 TDM reordering to expose two microphones plus reference. Treat that as a hypothesis to validate on the real 1.85B, not as a patch to copy blindly.

Decision:

Do not change the 1.85B audio channel layout based on the related-board report alone. First capture and identify the physical TDM slots on hardware, then tune AEC/NS/gain and compare one-mic versus two-mic processing.

References:

- https://docs.espressif.com/projects/esp-sr/en/latest/esp32s3/acoustic_echo_cancellation/README.html
- https://docs.espressif.com/projects/esp-sr/en/latest/esp32/audio_front_end/Espressif_Microphone_Design_Guidelines.html
- https://docs.espressif.com/projects/esp-sr/en/latest/esp32s3/benchmark/README.html
- https://docs.waveshare.com/ESP32-S3-Touch-LCD-1.85B
- https://github.com/78/xiaozhi-esp32/issues/2229

## Home Assistant Voice Preview Edition

Purpose: reference for how a modern open voice device treats the acoustic front end.

Useful idea:

Home Assistant pairs an ESP32-S3 with dual microphones and a dedicated XMOS XU316 audio processor for echo cancellation, stationary-noise removal and automatic gain control.

Decision:

Use this as evidence that audio-front-end quality deserves dedicated engineering, not as a requirement to add XMOS to Nara. Tune and measure the current Waveshare + ESP-SR path first; dedicated DSP or a different hardware target is an escalation only if measured results justify it.

Reference:

- https://www.home-assistant.io/voice-pe/

## NIST speaker-recognition evaluations

Purpose: reminder that speaker identity is probabilistic and sensitive to recording conditions.

Useful finding:

NIST evaluations document significant speaker-recognition performance changes under domain/channel, language, duration and recording-condition mismatch.

Decision:

Voice/speaker recognition is a personalization/confidence signal, not Nara's root authentication mechanism. When identity is uncertain, preserve general functionality and reduce privilege rather than locking the companion.

References:

- https://www.nist.gov/publications/2016-nist-speaker-recognition-evaluation
- https://www.nist.gov/publications/2018-nist-speaker-recognition-evaluation


## Offline voice and local-runtime research

Purpose: define what Nara can truthfully promise with no Internet and where local compute should live.

Useful findings:

- ESP-SR MultiNet provides offline command recognition on ESP32-S3 for up to 200 custom commands, with official Chinese/English support.
- ESP-SR's embedded speech-synthesis module currently supports Chinese only.
- The Waveshare 1.85B has an RTC and TF/microSD in addition to touch, IMU, audio and BLE, so meaningful isolated-device utilities and local media are practical.
- ESP32-S3 supports Bluetooth LE but not Bluetooth Classic or LE Audio, so BLE should be used for control/pairing/sync rather than assumed as a general audio link.
- Home Assistant demonstrates a fully local voice architecture where an embedded voice endpoint delegates STT/TTS to local network services through Wyoming.
- Whisper is multilingual and includes Indonesian, making it a local-network STT candidate.
- The current Open Home Foundation Piper continuation lists Bahasa Indonesia, but its GPL licensing means Nara should treat it as an optional external service unless redistribution implications are explicitly reviewed.
- ESP-IDF supports NVS and flash encryption for production device storage, with irreversible/lifecycle implications that must be validated before manufacturing settings are burned.

Decision:

Nara adopts capability degradation rather than a binary online/offline product state. The isolated ESP32 stays useful with local utilities and an authorized offline personal capsule; free-form Indonesian voice can be restored by a local-network compute node without changing the device protocol.

References:

- https://docs.espressif.com/projects/esp-sr/en/latest/esp32s3/speech_command_recognition/README.html
- https://docs.espressif.com/projects/esp-sr/en/latest/esp32s3/getting_started/readme.html
- https://docs.espressif.com/projects/esp-sr/en/latest/esp32/speech_synthesis/readme.html
- https://docs.waveshare.com/ESP32-S3-Touch-LCD-1.85B
- https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/api-guides/ble/overview.html
- https://docs.espressif.com/projects/esp-adf/en/latest/solution-center/bluetooth-audio.html
- https://www.home-assistant.io/integrations/wyoming
- https://www.home-assistant.io/voice_control/voice_remote_local_assistant
- https://github.com/openai/whisper
- https://github.com/OHF-Voice/piper1-gpl
- https://k2-fsa.github.io/sherpa/onnx/
- https://docs.espressif.com/projects/esp-idf/en/latest/esp32/api-reference/storage/nvs_encryption.html


## Physical companion interactions

Purpose: determine which pet-like physical interactions the first Waveshare body can actually support.

Hardware findings:

- Waveshare documents the 1.85B with QMI8658 six-axis IMU and CST816S capacitive touch.
- QMI8658 supports raw acceleration/gyro plus tap, any-motion, no-motion, significant-motion and wake-on-motion functions in the sensor family.
- CST816S implementations expose single-finger coordinates and gesture IDs including swipe, single click, double click and long press.
- the 1.85B quick reference lists the touchscreen interrupt GPIO but only I2C lines for QMI8658, so hardware wake-on-motion interrupt must not be assumed until schematic/hardware verification.
- the board has no motor/servo/vibration actuator, so physical responses are visual/audio unless extra hardware is added.

Industry pattern:

- LivingAI documents EMO interactions including pickup, petting, shaking and laying down.
- LivingAI support documents AIBI interactions including petting, shaking, tap, double click/teasing and upside down.
- Loona publishes touch, 3-axis accelerometer and 3-axis gyroscope among its companion sensors.

Decision:

Use the same broad interaction pattern without copying product behavior: sensor event -> immediate local reflex -> personality variation -> optional AI speech. Touch/motion must remain useful offline and raw high-rate telemetry stays local by default.

References:

- https://docs.waveshare.com/ESP32-S3-Touch-LCD-1.85B
- https://docs.waveshare.com/ESP32-S3-Touch-LCD-1.85B/ESP-IDF
- https://files.waveshare.com/upload/5/5f/QMI8658A_Datasheet_Rev_A.pdf
- https://github.com/fbiego/CST816S
- https://living.ai/docs/emo/interaction/physical/
- https://living.ai/support/
- https://keyirobot.com/products/petbot


## Phone connectivity, commissioning and direct-peer UX

Purpose: choose how Nara should connect to phones without making Bluetooth, a cloud app or Internet connectivity a permanent dependency.

Projects and references reviewed:

- Espressif ESP-IDF Unified Provisioning / Network Provisioning;
- ESP-IDF Wi-Fi Easy Connect (DPP) for ESP32-S3;
- ESP-IDF Wi-Fi/BLE RF coexistence guidance;
- ESP-IDF SoftAP and SoftAP+Station examples;
- ESP RainMaker firmware and phone provisioning flows;
- ESPHome provisioning, Improv BLE and factory-project patterns;
- Matter/connectedhomeip commissioning flows and esp-matter lifecycle behavior.

Useful findings:

- ESP-IDF supports BLE GATT or SoftAP+HTTP provisioning and Security 2 based on SRP6a + AES-256-GCM.
- ESP32-S3 supports DPP enrollee mode using a displayed QR code; compatible phones can provision Wi-Fi without a Nara app.
- RainMaker treats QR as onboarding metadata and then performs the actual transfer over BLE or SoftAP.
- RainMaker defaults to BLE but retains SoftAP as a supported alternative.
- ESPHome exposes BLE Improv and captive-portal/fallback-AP patterns, but explicitly warns that BLE memory pressure can collide with heavy voice/audio workloads.
- ESP-IDF documents that Wi-Fi and BLE share the ESP32-S3 2.4 GHz radio; supported coexistence does not mean simultaneous use is free.
- Matter uses BLE as a commissioning channel and common esp-matter configurations release BLE resources after commissioning when persistent BLE is not required.
- Home Assistant Voice Preview Edition's factory firmware is an especially relevant voice-device pattern: it enables BLE on Wi-Fi disconnect, disables BLE after Wi-Fi connects, and waits for BLE to be disabled before the voice-assistant client proceeds.
- ESP-IDF's SoftAP+Station examples prove the chip can support both roles, but Nara should not keep a peer AP exposed continuously just because APSTA exists.

- Nara firmware currently pins `78/esp-wifi-connect ~3.3.1`. Its upstream configuration portal presently creates an open SoftAP (`WIFI_AUTH_OPEN`) and uses plain HTTP for Wi-Fi configuration. It is therefore a development/reference provisioning surface, not a safe place for Nara private peer data.
- ESP-IDF's own SoftAP examples support WPA2/WPA3 and Protected Management Frames, so a secure peer AP does not need to inherit the open-portal policy.

Decision:

Use Wi-Fi as Nara's primary runtime data plane. Phone hotspot is ordinary Wi-Fi station connectivity. The first direct-phone/no-Internet experience is an on-demand SoftAP with an authenticated local web UI, so no native app is required. BLE remains a short-lived/on-demand provisioning/control transport and should be deinitialized or dormant during normal voice operation until real 1.85B measurements justify otherwise. DPP is an optional Android-friendly fast path. Production provisioning should migrate deliberately toward Unified/Network Provisioning Security 2 instead of expanding the inherited proprietary setup path.

References:

- https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/provisioning/provisioning.html
- https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-reference/network/esp_dpp.html
- https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-guides/coexist.html
- https://github.com/espressif/esp-idf/tree/master/examples/wifi
- https://github.com/78/esp-wifi-connect/blob/main/wifi_configuration_ap.cc
- https://docs.rainmaker.espressif.com/docs/dev/phone-app/home-app/home-app-device-setup/
- https://docs.rainmaker.espressif.com/docs/dev/firmware/firmware_dev_tips/
- https://github.com/espressif/esp-rainmaker-home
- https://esphome.io/components/provisioning/
- https://esphome.io/components/esp32_improv/
- https://github.com/esphome/esphome-project-template
- https://github.com/esphome/home-assistant-voice-pe/blob/dev/home-assistant-voice.factory.yaml
- https://github.com/project-chip/connectedhomeip
- https://github.com/espressif/esp-matter


## Telegram idle delivery and durable device inbox

Purpose: allow a trusted remote sender to reach a physical Nara even when the
realtime voice WebSocket is intentionally closed to save tokens and power.

Useful findings:

- Telegram Bot API supports long polling through `getUpdates`; a positive
  timeout is recommended for long polling rather than repeated short polling;
- Telegram updates are not a durable device-delivery queue after the bot has
  consumed them, and pending updates are retained for no longer than roughly
  24 hours;
- Nara firmware already opens its realtime WebSocket only when audio is needed,
  so keeping a Gemini/realtime session alive merely for remote messages would
  undo an existing cost-saving property.

Decision:

The gateway consumes Telegram through allowlisted long polling, then owns
delivery reliability in a bounded file-backed per-device inbox. Idle firmware
polling returns local notification payloads or a compact voice-wake signal.
Queued ask/say prompts remain server-side. A voice wake opens a one-shot
realtime session without microphone listening and closes after TTS. Queue
items have TTL/lease/retry semantics so stale work expires and temporary
delivery failures can retry.

References:

- https://core.telegram.org/bots/api
- https://core.telegram.org/bots/faq


## ESP32-S3 idle polling and Wi-Fi power tradeoffs

Purpose: make remote idle delivery useful without claiming that periodic Wi-Fi
checks are free on battery.

Useful findings:

- ESP-IDF documents modem-sleep modes where a station can remain associated
  while RF/PHY/baseband sleep between required receive windows;
- minimum-modem and maximum-modem power-save modes trade receive latency and
  responsiveness for lower power;
- listen interval/DTIM behavior and the real access point materially affect
  power and wake latency.

Decision:

Do not hold the realtime AI/audio WebSocket open while the companion is idle.
Use a small authenticated HTTP poll instead, with software defaults of 15
seconds normally, 60 seconds in battery saver and 120 seconds at critical
battery. These are conservative product defaults, not measured battery-life
claims; final intervals must be tuned from hardware-in-the-loop current,
latency and router/hotspot measurements.

References:

- https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/api-guides/wifi-driver/wifi-performance-and-power-save.html
- https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-guides/low-power-mode/low-power-mode-wifi.html


## Hermes Runs API

Purpose: delegate long browser/research/multi-step work without placing an
agent framework in Nara's realtime microphone/speaker critical path.

Useful findings:

- Hermes Agent exposes asynchronous Runs endpoints for start/status/stop;
- API-server deployments support bearer authentication and idempotent run
  creation;
- profile-prefixed API routes allow independent Hermes profiles.

Decision:

Nara integrates Hermes as an optional Runs API tool. `HERMES_BASE_URL` is the
server root and Nara appends the Runs paths itself. A managed SumoPod Hermes
service, a generic VPS or a self-hosted Hermes server can therefore be swapped
by configuration. Simple realtime turns stay on the voice path; Hermes is for
work that benefits from agent/browser/tool execution.

Reference:

- https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/api-server.md

## OpenAI-compatible speech endpoint contract

Purpose: define a small first STT/TTS adapter contract for chained voice
without making OpenAI itself a mandatory Nara dependency.

Useful findings:

- the current OpenAI transcription API accepts an uploaded audio file,
  including WAV, at `POST /audio/transcriptions`, with JSON transcription
  output and optional ISO-639-1 language hint;
- the current speech API uses `POST /audio/speech`, accepts a model, voice and
  input text, and supports raw PCM output;
- current OpenAI PCM playback examples use 24 kHz, 16-bit signed,
  little-endian mono audio;
- the speech endpoint limits one input request to 4096 characters.

Decision:

Nara's first chained speech adapters target only this narrow
OpenAI-compatible surface. PCM turns are wrapped as WAV for STT; TTS requests
raw PCM and exposes sample rate as deployment configuration. Cloud credentials
remain server-side, and an unauthenticated compatible localhost gateway can be
used by omitting `api_key_env`. Provider/model choice remains configuration.

References:

- https://developers.openai.com/api/reference/cli/resources/audio/subresources/transcriptions/methods/create
- https://developers.openai.com/api/reference/cli/resources/audio/subresources/speech/methods/create
- https://developers.openai.com/api/docs/guides/text-to-speech
