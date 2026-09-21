# Audio robustness and voice-identity fallback

Status: research-backed design proposal; hardware measurements still required.

Last reviewed: 2026-09-21

## Product requirement

Nara must remain useful when:

- the microphone is noisy, blocked, quiet, clipping, or partly faulty;
- the speaker is weak, distorted, or leaks heavily into the microphones;
- wake-word detection misses;
- speech-to-text misunderstands an utterance;
- speaker/voice recognition cannot confidently identify the person;
- the room contains TV/music/fans/other speakers;
- the user is farther away than expected.

Voice quality and voice identity are probabilistic. They must never become a single point of failure for the companion.

## Separate the failure modes

These are different systems and should be measured separately:

1. **Wake word** — did Nara notice that someone wants its attention?
2. **Speech capture / ASR** — what words were spoken?
3. **Speaker recognition** — who probably spoke them?
4. **Playback** — can the user hear Nara clearly?
5. **AEC / barge-in** — can Nara hear the user while its own speaker is active?

A failure in one layer must not silently be interpreted as failure in another.

For example, good transcription does not prove speaker identity. A failed voice match does not mean the user should lose all access to their claimed device.

## Current hardware baseline

The Waveshare ESP32-S3-Touch-LCD-1.85B is not a minimal audio board. Waveshare documents:

- dual microphones;
- ES7210 audio input / echo-cancellation path;
- ES8311 audio output codec;
- onboard speaker path;
- ESP32-S3 with PSRAM.

Official reference:

- https://docs.waveshare.com/ESP32-S3-Touch-LCD-1.85B

This is a reasonable prototype baseline, but published component lists do not prove real-world far-field performance.

## Current Nara firmware findings

The current target configuration already enables device AEC:

- `AUDIO_INPUT_REFERENCE = true`;
- `CONFIG_USE_DEVICE_AEC=y`;
- `BoxAudioCodec` is duplex;
- `AfeAudioEngine` uses Espressif AFE;
- AEC mode is `AEC_MODE_FD_LOW_COST`.

Current AFE configuration is important:

```text
AEC: enabled when playback reference is available
AEC mode: FD_LOW_COST
AEC NLP: VERYAGGR
NS: OFF
AGC: OFF
VAD: ON for voice processing
```

Espressif documents `FD_LOW_COST` as the normal performance/resource balance for full-duplex use.

However, `AEC_NLP_LEVEL_VERYAGGR` is the strongest residual-echo suppression and Espressif warns that it can damage near-end speech more than less-aggressive modes. This is therefore a tuning variable, not an unquestioned default.

Noise suppression and automatic gain control are currently disabled in Nara's AFE configuration. That means poor first hardware results should trigger measurement/tuning before concluding the board is unsuitable.

## High-priority channel-layout hypothesis

The physical board is advertised as dual-microphone, but Nara's current generic `BoxAudioCodec` reports two logical input channels whenever playback reference is enabled.

`AfeAudioEngine` derives its input format from that as:

```text
MR
M = one microphone
R = one playback reference
```

So the current AFE path appears to consume one speech microphone plus one reference channel, not two speech microphones plus reference.

Espressif's AFE benchmark distinguishes:

```text
MR    = 1 mic + reference
MMNR  = 2 mics + noise/reference layout used by multi-channel processing
```

A very recent XiaoZhi issue for the related Waveshare ESP32-S3 Touch AMOLED 1.75 reports a board-specific ES7210 TDM order where the generic two-channel path did not expose both physical microphones plus playback reference. The reporter reordered the stream to `MMR` and observed better wake/recognition behavior on that board.

That report is useful evidence but **not proof that the 1.85B has identical wiring or that the same patch is correct**.

Decision for now:

- do not copy the 1.75 patch blindly;
- when the 1.85B hardware arrives, capture all ES7210 TDM slots;
- identify which slots are MIC1, MIC2, playback reference, and unused;
- verify level/phase/reference behavior;
- only then decide whether Nara should expose `MR`, `MMR`, or another board-specific layout to AFE.

References:

- https://github.com/78/xiaozhi-esp32/issues/2229
- https://docs.espressif.com/projects/esp-sr/en/latest/esp32s3/benchmark/README.html

## Why enclosure and speaker placement matter

Audio quality is not only a model/software problem.

Espressif's hardware guidance recommends:

- microphone holes that are not blocked or excessively deep;
- sealing/damping between microphone and shell;
- physical separation/isolation from the speaker cavity;
- microphone-array sensitivity consistency within roughly 3 dB;
- avoiding saturation in the playback-reference channel;
- controlling speaker distortion at high volume.

Therefore an open development board and the final gift enclosure must both be tested. A nice enclosure can make recognition worse if a mic hole is obstructed, the speaker vibrates the shell, or acoustic leakage changes.

Reference:

- https://docs.espressif.com/projects/esp-sr/en/latest/esp32/audio_front_end/Espressif_Microphone_Design_Guidelines.html

## Voice identity must fail soft

Speaker recognition is a confidence signal, not a password.

Research evaluations from NIST repeatedly show speaker-recognition performance is affected by mismatched channel/domain, language, duration, noise, and recording conditions.

Nara's behavior should therefore be confidence-aware:

```text
high confidence
    -> apply likely person's ordinary personalization

uncertain
    -> continue general conversation
    -> do not expose sensitive memory
    -> optionally ask for light confirmation when needed

unknown / poor audio
    -> guest / least privilege for private information
    -> conversation still works
```

For a recipient-owned device, failure to recognize the recipient's voice must not make the device unusable.

Sensitive actions and sensitive memories should use stronger confirmation such as recent authenticated phone session, passkey, or deliberate local-screen confirmation.

References:

- https://www.nist.gov/publications/2016-nist-speaker-recognition-evaluation
- https://www.nist.gov/publications/2018-nist-speaker-recognition-evaluation
- https://support.apple.com/en-gb/108397

## Multiple fallback interaction paths

Nara has a display, touch input, and a physical button. Use them.

### Wake word unreliable

Fallback:

- tap the screen;
- press/tap the hardware control for push-to-talk / toggle chat;
- optionally initiate from the phone companion page later.

Current firmware already maps the BOOT button to chat-state toggling outside startup, so a physical non-wake-word path exists conceptually.

### Speech-to-text uncertain

Do not invent certainty.

Possible UX:

```text
"Aku nangkepnya: '...'. Bener?"
```

Only use explicit confirmation for material ambiguity. Do not annoy the user on every minor transcription uncertainty.

The screen can show the live/final transcript so the user can visually catch obvious mistakes.

### Voice identity uncertain

Possible UX for a private request:

```text
"Aku belum yakin yang ngomong siapa.
Aku masih bisa bantu hal umum.
Untuk yang pribadi, konfirmasi di layar ya."
```

Touch confirmation can be enough for a locally defined medium-risk action; truly sensitive operations should use phone/passkey authentication.

### Speaker unclear or broken

The display should retain text/subtitles for every important response.

If playback repeatedly fails, Nara can remain usable as a visual/touch companion and expose a phone fallback until hardware is repaired.

## Audio health monitoring

Do not store raw private audio by default just to diagnose quality.

Record compact diagnostics where practical:

- microphone RMS / peak level;
- clipping percentage;
- silence/near-zero percentage;
- VAD speech/silence transitions;
- packet/drop counts;
- selected input gain;
- speaker volume;
- AEC mode/NLP level;
- reference-channel level;
- optional estimated residual echo/noise quality metric;
- ASR confidence/repair/retry counts when a provider exposes them.

These metrics help distinguish:

```text
bad microphone
vs
bad acoustic environment
vs
bad AEC
vs
network loss
vs
ASR/provider error
vs
speaker-recognition uncertainty
```

Raw recordings should only be captured in an explicit diagnostic mode, with clear consent and deletion.

## Built-in self-test

A physical companion should be able to diagnose itself.

Suggested diagnostic flow:

1. show live mic level meter while the user speaks;
2. capture each physical mic/reference channel separately;
3. play a known test signal through the speaker;
4. measure whether microphones hear it and whether the reference channel behaves as expected;
5. run an AEC on/off comparison;
6. detect obvious silence, clipping, swapped channel, or missing reference;
7. play a spoken test phrase and ask whether it is audible;
8. save metrics, not personal conversation audio, by default.

The firmware already has an audio-testing path that records and plays back audio, which is a useful foundation.

## Hardware-in-the-loop test matrix

Before deciding that the Waveshare audio hardware is good enough, test at least:

| Scenario | What to measure |
| --- | --- |
| 30 cm, quiet | baseline transcription, level, clipping |
| 1 m, quiet | normal desk use |
| 2–3 m, quiet | far-field limit |
| fan / AC noise | stationary-noise robustness |
| TV / another voice | competing-speech robustness |
| Nara speaker quiet | AEC baseline |
| Nara speaker medium | normal barge-in |
| Nara speaker loud | residual echo / clipping |
| user interrupts Nara | full-duplex/barge-in success |
| different directions | microphone pickup geometry |
| final enclosure | structural/acoustic regression |
| natural Indonesian speech | actual target-language experience |
| recipient voice samples | speaker-ID confusion/unknown rate |

Do not evaluate only "did it work once".

Track repeatable metrics such as:

- wake-word false reject / false activation rate;
- ASR word/error repair rate on a fixed phrase set;
- interruption success rate;
- voice-ID false match / missed match / unknown rate;
- AEC residual-echo observations;
- audio clipping/drop rate;
- latency.

## Tuning order

When the real board arrives, change one variable at a time.

Recommended order:

1. verify raw physical mic/reference channel mapping;
2. verify mic levels and clipping;
3. tune ES7210 input gain;
4. verify playback reference timing/level;
5. compare AEC `NORMAL`, `AGGR`, and `VERYAGGR`;
6. evaluate Espressif NS for stationary noise;
7. evaluate AGC only if level variation still harms recognition;
8. compare one-mic vs two-mic AFE path if the hardware exposes both correctly;
9. tune speaker maximum volume/EQ if necessary;
10. repeat in the final enclosure.

Do not simultaneously enable every DSP feature. Over-processing can make speech less natural or damage recognition.

## Dedicated audio DSP is Plan B, not Plan A

A useful industry comparison is Home Assistant Voice Preview Edition. It uses an ESP32-S3 but also includes a dedicated XMOS XU316 for echo cancellation, stationary-noise removal, and automatic gain control alongside a dual-mic array.

This demonstrates how seriously mature voice hardware treats the acoustic front end.

It does **not** mean Nara needs XMOS now.

Escalation path:

```text
Waveshare stock hardware
  -> verify channel layout
  -> tune ESP-SR AFE
  -> test enclosure
  -> measure real failure rates
  -> only then consider dedicated DSP / external audio board / another hardware target
```

Reference:

- https://www.home-assistant.io/voice-pe/

## Server-side speaker recognition

Do not run identity recognition on the ESP32 unless measurement later gives a compelling reason.

The ESP32 should focus on low-latency audio capture, AEC/VAD/wake behavior, and transport.

Speaker embeddings/identification can be a replaceable server-side provider. Current open-source candidates worth benchmarking later include sherpa-onnx, WeSpeaker, and pyannote.audio.

Do not choose one from README claims alone. Benchmark them on **audio captured from the actual Nara device**, including quiet, noisy, near, far, and post-AEC conditions.

Store embeddings/models as sensitive personal data. Prefer deleting raw enrollment recordings after embedding creation unless the user explicitly opts to retain them for retraining.

## Product-level acceptance rule

The device is ready for gifting only when all of these are true:

- ordinary conversation works without voice identification;
- wake-word failure has a touch/button fallback;
- speaker-recognition failure downgrades permissions instead of breaking the device;
- private memory cannot be exposed merely because voice recognition guessed wrong;
- important responses remain visible as text when speaker output is poor;
- mic/speaker/AEC can run a diagnostic self-test;
- real-board audio tests pass at normal recipient distances/noise;
- final enclosure does not materially regress the audio results;
- no firmware change based on the related 1.75 board is merged without validating the exact 1.85B channel layout.
