# Physical interaction and local reflexes

Status: accepted product direction; hardware thresholds remain uncalibrated until the Waveshare 1.85B is tested.

Last reviewed: 2026-09-21

## Product goal

Nara should feel physically present even when the network is unavailable.

Touch and motion reactions belong primarily in a **local reflex layer** on the device. They should not require an LLM, cloud round-trip, or server connection for basic expressions and sounds.

The desired experience is closer to a small companion/pet than to a smart-speaker screen.

## Hardware we actually have

The first target, Waveshare ESP32-S3-Touch-LCD-1.85B, includes:

- QMI8658 6-axis IMU:
  - 3-axis accelerometer;
  - 3-axis gyroscope;
- CST816S capacitive touchscreen;
- 360 × 360 LCD;
- speaker and microphones;
- BOOT button;
- battery gauge and RTC.

The QMI8658 family supports raw acceleration/rotation plus embedded functions including:

- single/double tap detection;
- any-motion;
- no-motion;
- significant-motion;
- wake-on-motion.

The CST816S exposes single-finger touch position and common gesture IDs such as:

- swipe up/down/left/right;
- single click;
- double click;
- long press.

The current Nara server contract already anticipates semantic events such as:

```text
touch:
  tap
  double_tap
  hold
  swipe

imu:
  lift
  shake
  tilt
  face_down
```

However, the physical 1.85B firmware does not yet appear to turn the real CST816S/QMI8658 data into those Nara events. The hardware and semantic contract exist; the physical bridge is the missing layer.

## Important hardware limits

### Petting is naturally screen-based

A finger moving across the touchscreen can become a convincing "petting/stroking" interaction.

The aluminum case outside the touchscreen has no dedicated body-wide touch sensor. Stroking only the outer metal housing cannot be reliably detected as touch with the current hardware.

If body-wide petting becomes important later, add a dedicated capacitive-touch electrode/sensor rather than trying to infer it unreliably.

### No pressure sensing

CST816S touch reports contact/coordinates, not useful pressure/force data for a "gentle vs hard press" feature.

Nara can infer speed, duration, path, repetition and location, but not true finger pressure.

### No absolute compass heading

The QMI8658 is accelerometer + gyroscope, not a magnetometer.

Nara can robustly infer:

- gravity direction;
- face-up / face-down;
- pitch/roll;
- rapid angular motion;
- short-term rotation/spin.

Absolute yaw/compass heading will drift if integrated from the gyro alone and should not be treated as a stable direction.

### Pickup is an inference

There is no bottom proximity/cliff sensor on this board.

"Lifted from the table" can be inferred from a transition such as:

```text
stable/no-motion
  -> acceleration / angular movement
  -> orientation change
  -> new stable pose
```

but it cannot be proven perfectly. Avoid treating it as a security signal.

### No physical actuator

The board has no motor, servo, or vibration motor.

Nara can react through:

- face animation;
- gaze;
- screen effects;
- speaker sound;
- speech.

It cannot physically wiggle or move its body without extra hardware.

## Local reflex architecture

Do not send raw IMU or raw touch points to the LLM.

Use:

```text
CST816S / QMI8658
       |
       v
raw samples
       |
       v
gesture classifier
       |
       | semantic local event
       v
local reflex policy
       |
       +----> face / gaze
       +----> local sound
       +----> optional recorded phrase
       |
       +----> compact event to gateway (when online)
                    |
                    v
          optional higher-level response
```

The first reaction should be immediate and local.

Cloud/LLM speech is optional enrichment, not the reflex itself.

## Reaction latency tiers

### Tier 1 — reflex

Target: visually immediate, roughly tens of milliseconds to low hundreds of milliseconds.

Examples:

- touch -> eyes follow finger;
- tap -> blink/startle;
- tilt -> pupils compensate toward gravity;
- flip -> surprised eyes.

No network.

### Tier 2 — recognized gesture

Target: after enough samples confirm the gesture.

Examples:

- repeated stroke -> petting;
- repeated acceleration -> shake;
- stable inverted pose -> upside-down;
- fast angular velocity -> spin;
- impact followed by stillness -> set-down.

No network required.

### Tier 3 — optional speech/personality

After the local reaction, Nara may say something.

Prefer:

- local recorded phrases offline;
- local deterministic phrase pool;
- server/LLM-generated speech only when online and worth the latency/cost.

Do not call an LLM for every touch or shake.

## Candidate gestures

### Touchscreen gestures

#### Tap

Input:

- single click from touch controller or short coordinate contact.

Reaction ideas:

- quick blink;
- pupils jump toward touch point;
- tiny surprised mouth.

#### Double tap

Reaction ideas:

- playful/surprised;
- different local sound;
- optional "ih..." style short phrase.

#### Hold

Reaction ideas:

- eyes slowly close;
- relaxed/happy expression;
- gentle idle sound.

This can function as a simple "comfort/pat" action.

#### Stroke / pet

Derived from continuous touch coordinates rather than one raw swipe.

Classifier should consider:

- path length;
- speed;
- duration;
- repeated back-and-forth movement;
- whether the path stays in a designated petting region;
- short interruption tolerance.

Reaction ideas:

- eyes close;
- happy/shy;
- blush;
- slow breathing;
- subtle pleasant sound.

Repeated frantic strokes should not be identical to gentle petting.

#### Swipe

Use as either:

- deliberate UI navigation; or
- personality interaction when no menu is open.

Interaction and navigation contexts must be distinct so Nara does not become annoyed merely because the user scrolls a settings page.

#### Gaze-follow

While a finger is touching the face, map the touch coordinate to `SetGaze(x, y)`.

The eyes can literally follow the user's fingertip. This is cheap, local, and likely to feel much more alive than a spoken response.

## IMU gestures

### Tilt

Use gravity vector to estimate pitch/roll.

Reaction:

- eyes can counter-rotate/follow gravity;
- slight confused expression at stronger tilt.

Do not trigger speech for ordinary small orientation changes.

### Face down / upside down

Face-down on table and fully inverted in hand are different episodes and should be classified separately if hardware data permits.

Example:

- short inversion: surprised;
- sustained inversion: annoyed/dizzy;
- long inversion: optional "balikin..." phrase.

Use hysteresis and minimum duration so a normal rotation does not trigger repeatedly.

### Shake

Detect repeated high acceleration and angular velocity over a short window.

Classify at least:

- mild shake;
- strong/repeated shake.

Reaction ideas:

- mild: surprised/dizzy;
- repeated/strong: annoyed;
- recovery animation after motion stops.

Do not reward dangerously violent motion.

### Spin / rapid rotation

Gyroscope is well suited to detecting fast angular motion.

Reaction ideas:

- pupils lag behind;
- dizzy expression after stop;
- short "pusing..." local line.

### Pick up / set down

Derived episode:

```text
no-motion
-> motion
-> orientation/acceleration change
-> new stable state
```

Possible reactions:

- pickup: eyes widen and look around;
- held stationary: curious/relaxed;
- set down: tiny impact reaction then settle.

Because pickup is inferred, false positives must be harmless.

### Physical tap / knock on casing

The QMI8658 tap engine can detect single/double acceleration impulses when configured.

This potentially lets the user knock/tap the metal case even outside the touchscreen.

It must be calibrated against:

- table bumps;
- speaker vibration;
- plugging USB;
- setting the device down.

### Rocking

Detect periodic pitch/roll oscillation with low-to-moderate amplitude.

Potential reaction:

- sleepy/relaxed;
- useful as a "soothing" interaction.

This is software-derived, not a dedicated QMI hardware event.

### Drop/free-fall diagnostic

Near-zero acceleration followed by a large impact can indicate a drop.

Use only for:

- logging a possible drop;
- protective state/recovery animation;
- diagnostics.

Do not create gameplay that encourages dropping the device.

## Interaction state and anti-annoyance rules

A companion becomes irritating if every sensor event causes speech.

Use local rules:

### Cooldowns

Examples:

- no spoken shake reaction more than once in a short window;
- repeated petting may continue animation without restarting speech;
- tilt has visual response only unless extreme/sustained.

### Hysteresis

A pose must leave one threshold before it can retrigger it.

This prevents:

```text
face_down
not_face_down
face_down
not_face_down
```

from noisy sensor samples near a boundary.

### Episode detection

Treat a gesture as an episode:

```text
shake_started
shake_active
shake_ended
```

rather than emitting 50 independent shake events.

### Context

If Nara is:

- in settings/menu -> touch primarily means UI;
- sleeping -> touch/motion may wake;
- speaking -> a strong tap/touch may interrupt depending on UX;
- updating -> ignore nonessential gestures;
- audio-testing -> keep sensor behavior deterministic.

### Intensity

Keep a normalized gesture intensity, for example `0..1`, so face behavior can scale without hardcoding many discrete animations.

### Variety without chaos

Use small weighted pools of local reactions.

Example petting:

```text
70% happy relaxed
20% shy/blush
10% playful surprise
```

Avoid repeating one canned line every time.

Randomness should be seeded/controlled enough for tests.

## Proposed semantic events

Do not expose raw hardware details to the server.

Possible extension:

```text
touch.tap
touch.double_tap
touch.hold
touch.stroke
touch.swipe

motion.tilt
motion.face_down
motion.upside_down
motion.shake
motion.spin
motion.pickup
motion.set_down
motion.knock
motion.rock
```

Each event may include:

```text
intensity
duration_ms
direction
position
confidence
```

The exact protocol should be finalized only after the physical classifier exists.

## Local emotion mapping

Initial mapping for prototype tests:

| Gesture | Immediate local response |
| --- | --- |
| tap face | blink / look at finger |
| double tap | surprised/playful |
| hold | relax / eyes half-close |
| gentle stroke | happy or shy, possible blush |
| repeated rough stroke | less happy / annoyed |
| small tilt | gaze compensates |
| strong tilt | confused |
| upside down | surprised -> annoyed if sustained |
| mild shake | surprised/dizzy |
| repeated strong shake | annoyed + recovery |
| spin | dizzy |
| pick up | surprise/curiosity |
| set down | small impact then neutral |
| casing knock | blink/startle |
| gentle rocking | sleepy/relaxed |

These are defaults, not permanent personality law. Character profiles may tune probabilities and phrase pools.

## Optional speech

Local physical reactions should usually be nonverbal.

Speech is more effective when rare.

Example pools:

Petting:

```text
"hehe..."
"nyaman..."
```

Upside-down:

```text
"eh, kebalik..."
"balikin dong..."
```

Shake:

```text
"pusing..."
"woi pelan-pelan..."
```

Do not hardcode private names in firmware.

Offline speech can initially use pre-generated/recorded assets. Online personality speech can later be generated by the runtime if desired.

## Relationship / mood layer

Physical interaction can contribute to a short-lived local state without becoming permanent psychological fiction.

Example ephemeral variables:

```text
comfort
playfulness
annoyance
sleepiness
recent_pet_count
recent_rough_motion
last_interaction_time
```

They decay over time.

This lets:

- repeated gentle petting gradually relax Nara;
- repeated shaking make reactions more annoyed;
- a quiet period return Nara toward neutral.

Do not save every touch as long-term personal memory.

Only meaningful derived events should ever be candidates for durable memory, and usually they should remain session/local state.

## Offline-first value

This layer is especially valuable because it works with no Internet:

- touch;
- gaze follow;
- petting;
- tilt;
- shake;
- upside-down;
- knock;
- pickup inference;
- local face/sound reactions.

It belongs in the same philosophy as `docs/OFFLINE_RUNTIME.md`:

> connectivity loss removes cloud capabilities, not physical personality.

## Low-power opportunity

QMI8658 supports wake-on-motion in the sensor family, but the 1.85B public quick-reference documents only the I2C connection for the IMU and does not list an IMU interrupt GPIO.

Do not assume hardware motion-wake from deep sleep is available on this exact board until the schematic/board test proves the interrupt line is physically usable.

If the interrupt is not wired, normal runtime can still poll the IMU while awake.

## Industry references

LivingAI companion products use the same interaction principle.

EMO officially supports physical interactions such as:

- pick up;
- pet;
- shake;
- lay down.

AIBI support material lists:

- petting;
- shaking;
- tap;
- double-click/teasing;
- upside down.

Loona's published hardware includes a touch sensor, 3-axis accelerometer and 3-axis gyroscope alongside its companion behavior.

The lesson is not to copy their animations. The useful pattern is:

```text
physical sensor
-> immediate deterministic reaction
-> personality variation
-> optional higher-level AI
```

## Implementation phases

### R0 — raw sensor bring-up

On the real 1.85B:

- initialize CST816S;
- initialize QMI8658;
- display/log raw touch coordinates;
- display/log accel + gyro;
- record the board's coordinate/orientation axes;
- verify touch and audio do not conflict on the shared I2C bus.

### R1 — deterministic classifiers

Implement and unit-test:

- tap / double tap / hold;
- stroke;
- tilt;
- face-down;
- upside-down;
- shake;
- spin;
- pickup/set-down inference;
- optional IMU knock.

Thresholds must be data-driven from the real enclosure.

### R2 — local reflex engine

Map events to:

- gaze;
- emotion;
- animation timing;
- local sounds;
- cooldown/hysteresis.

No gateway required.

### R3 — semantic event bridge

Send compact physical interaction events to Nara Gateway when online.

Do not stream raw high-rate IMU/touch telemetry by default.

### R4 — personality enrichment

Allow the character profile/runtime to customize:

- reaction probabilities;
- phrase pools;
- sensitivity;
- which gestures may trigger speech;
- relationship/mood decay.

### R5 — enclosure validation

Repeat classifiers after final assembly.

The enclosure can change:

- impact/tap signature;
- shake dynamics;
- orientation offsets;
- touch ergonomics;
- speaker-induced vibration.

## Acceptance criteria

Physical interaction is ready when:

1. face reacts to touch without network;
2. eyes can follow a finger across the face;
3. pet/stroke is distinguishable from ordinary menu interaction;
4. face-down and upside-down are not confused during normal rotations;
5. mild and strong shake do not trigger from speaker vibration;
6. pickup false positives are harmless and acceptably rare;
7. table bumps do not constantly trigger knock;
8. repeated gestures use cooldowns instead of repeating speech continuously;
9. raw sensor streams are not sent to cloud by default;
10. final enclosure thresholds are calibrated from measurements, not copied from another board.
