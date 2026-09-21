# Hardware plan

This document keeps the physical purchase/test plan in the repository so it does not depend on chat history.

Last reviewed: 2026-09-21

## First target

**Waveshare ESP32-S3-Touch-LCD-1.85B**

Nara Firmware already targets:

`waveshare/esp32-s3-touch-lcd-1.85b`

Official Waveshare documentation lists the board with:

- ESP32-S3R8;
- 8 MB PSRAM;
- 16 MB Flash;
- 1.85-inch 360 × 360 capacitive touch LCD;
- dual microphones;
- ES7210 echo-cancellation/audio-input path;
- ES8311 audio codec;
- built-in speaker according to the product page;
- QMI8658 six-axis IMU;
- BQ27220 battery gauge;
- PCF85063 RTC;
- TF/microSD support;
- USB Type-C programming/logging;
- 3.7 V lithium-battery interface.

Official references:

- https://docs.waveshare.com/ESP32-S3-Touch-LCD-1.85B
- https://www.waveshare.com/ESP32-S3-Touch-LCD-1.85B.htm

## What to buy first

Minimum hardware-in-the-loop kit:

1. Waveshare ESP32-S3-Touch-LCD-1.85B ×1.
2. USB Type-C **data** cable ×1 if a suitable cable is not already available.

That is enough for the first powered desk validation: flashing, logs, Wi-Fi, screen/touch, microphones, speaker, IMU, and realtime voice/action testing.

## Buy later, only when needed

### 3.7 V lithium battery

Optional for the first desk tests.

Buy it when portability/battery behavior becomes a milestone. Waveshare offers an optional 3.7 V 500 mAh battery variant and the board exposes an MX1.25 2-pin battery connector.

Before attaching a third-party battery:

- confirm connector size;
- confirm polarity;
- confirm voltage/chemistry;
- do not assume every visually compatible 2-pin battery has the same polarity.

### TF/microSD card

Not required for the first powered desk test or the minimum offline utility mode.

Because offline usefulness is now a product requirement, a TF/microSD card becomes **recommended for the offline personal-capsule milestone**, especially for:

- selected photos and gift media;
- pre-recorded personal voice messages;
- larger local assets that do not fit comfortably in flash;
- offline personal-capsule media;
- local diagnostics/log export.

Core offline functions such as face/touch, clock, timers, alarms, device status, and small built-in sounds should not require a card.

Do not store sensitive personal content on removable media in plaintext by default.

### Extra development accessories

Do not buy these by default:

- separate microphone;
- separate IMU;
- separate display;
- separate audio codec.

The target board already integrates those functions.

A USB/UART debugging adapter, bench supply, logic analyzer, or spare board may become useful only if hardware debugging shows a concrete need.

## Purchase gate

Software work can continue without the board for:

- memory;
- access policy;
- context composer;
- provider routing;
- tool routing;
- simulated device behavior;
- automated protocol tests.

Hardware should be on hand by the time the hardware-validation phase in `docs/PROJECT_STATE.md` begins, because these cannot be trusted from simulation alone:

- real microphone quality;
- echo cancellation;
- acoustic feedback;
- speaker loudness/distortion;
- interruption/barge-in;
- Wi-Fi behavior on the real enclosure;
- touch calibration;
- IMU orientation;
- sustained performance/thermal behavior;
- battery gauge and battery life.

## Hardware validation checklist

When the board arrives:

- record exact SKU/revision;
- photograph/record package contents privately if useful;
- restore/test factory firmware once;
- flash Nara Firmware;
- verify serial/USB logs;
- verify display and touch;
- verify both microphone channels;
- verify speaker playback;
- verify AEC while Nara is speaking;
- verify IMU axes;
- verify gateway connection and reconnect;
- verify real Opus uplink/downlink;
- verify interruption;
- verify at least one physical Action Runtime call;
- run a longer soak test;
- only then begin battery/power tuning.

Update this file after the hardware is purchased so future agents know exactly what exists physically.
