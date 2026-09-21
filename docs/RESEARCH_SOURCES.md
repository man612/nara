# Research sources and reuse policy

This is a compact record so future contributors and coding agents do not repeat the same research.

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
