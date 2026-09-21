# Architecture and product decisions

This is a compact durable decision log. Add entries when a choice would otherwise be rediscovered in future chats or coding sessions.

## 2026-09-21 — Repository is the project source of truth

**Status:** accepted

Important project direction, implementation state, hardware plan, and architectural decisions must be reconstructable from the repository.

Chat history may provide discussion context, but it is not the canonical project record.

Consequences:

- coding agents read `docs/PROJECT_STATE.md`;
- meaningful implementation batches update that checkpoint;
- research/decision docs are updated when conclusions change.

## 2026-09-21 — Public repo never stores personal memory

**Status:** accepted

The repository may contain schemas, examples, and test fixtures with fictional data.

Real names, biographies, private relationship context, conversation memory, credentials, recordings, and imported personal knowledge stay in private runtime storage outside Git.

The public docs use stable roles such as `owner`, `partner`, and `guest`.

## 2026-09-21 — First deployment is partner-focused; core stays multi-person

**Status:** accepted

The first real companion can be configured for a trusted partner, but "partner/doi" is a profile/deployment choice, not a core runtime concept.

The data model must support more people and relationships later without rewriting the runtime.

## 2026-09-21 — Personal knowledge is subject-aware and viewer-aware

**Status:** accepted

A memory fact is not just text. It has a subject (who it is about) and an access policy (who may receive it).

A question may have different viewer and subject identities.

## 2026-09-21 — Access control happens before prompt construction

**Status:** accepted

Nara must not insert unauthorized personal facts into an LLM context and rely on a prompt instruction to keep them secret.

Candidate memories are permission-filtered before the allowed subset is composed into model context.

## 2026-09-21 — Separate identity, people, memory, and project instructions

**Status:** accepted

Nara adopts the conceptual separation seen in mature agent runtimes:

- companion identity/personality;
- human/person profile;
- learned/durable memory;
- project-development instructions.

This is an architectural concept, not a dependency on Hermes or its file layout.

## 2026-09-21 — Memory remains behind a provider boundary

**Status:** accepted

Nara stays local-first for its first durable memory implementation, but the exact storage engine is intentionally not locked yet.

A storage implementation may later be replaced by a single-file database, PostgreSQL, or another backend without changing the device protocol or core conversation model.


## 2026-09-21 — Offline usefulness is a core product requirement

**Status:** accepted

Loss of Internet connectivity must degrade Nara's capabilities rather than make the device useless.

Consequences:

- connectivity state is separate from interaction state;
- isolated-device mode keeps local UI, touch/IMU behavior, clock/timer/alarm, diagnostics, and an authorized offline personal capsule;
- a temporary Wi-Fi failure must not behave like first-time setup forever;
- full free-form Indonesian conversation is not promised on the ESP32 alone;
- local-network STT/brain/TTS may be provided by replaceable local services without changing the device protocol;
- owner-private facts are never copied into a recipient's offline capsule;
- Bluetooth LE is for control/sync on ESP32-S3, not assumed to be an audio transport.


## 2026-09-21 — Physical interactions are local-first reflexes

**Status:** accepted

Touch and motion reactions are part of Nara's physical personality and must not depend on an LLM or Internet connection for their first response.

Consequences:

- CST816S/QMI8658 data is classified locally into semantic gestures;
- face/gaze/local sound reactions happen on-device;
- only compact derived events are sent to the gateway when useful;
- raw high-rate touch/IMU streams are not cloud telemetry by default;
- speech is optional enrichment and should be rare enough not to become annoying;
- thresholds are calibrated on the real 1.85B and final enclosure;
- body-wide petting outside the touchscreen is not promised without an added touch sensor.


## 2026-09-21 — Phone connectivity uses Wi-Fi as the main data plane

**Status:** accepted

Nara should work with a phone without making a native mobile app or persistent Bluetooth connection a first-release dependency.

Consequences:

- normal operation and phone tethering both use Wi-Fi station mode;
- direct no-Internet phone access starts with an on-demand SoftAP + authenticated local web UI;
- Bluetooth LE is temporary/on-demand for provisioning, discovery, small control/sync, or peer negotiation rather than the main realtime audio/data path;
- BLE should be released/dormant during normal voice operation unless real hardware measurements justify keeping it active;
- DPP/Wi-Fi Easy Connect is an optional fast provisioning path on compatible phones, not the only setup route;
- production provisioning should converge on secure ESP-IDF Unified/Network Provisioning semantics with per-device proof of possession;
- connectivity capability state remains independent from interaction/face state.

See `docs/PHONE_CONNECTIVITY.md`.


## 2026-09-21 — Nara is source-available, not open source

Decision:

- original Nara-authored code, documentation, configuration, product design,
  and modifications are proprietary to the repository owner;
- public repository visibility exists for transparency, inspection, project
  continuity, and reference, not as a grant to use or redistribute Nara;
- original Nara material is governed by the repository's proprietary
  source-available LICENSE / All Rights Reserved terms;
- the Node package remains private and is marked UNLICENSED;
- unsolicited third-party code contributions are not accepted by default;
- third-party software keeps its own licenses and must never be swept into
  Nara's ownership claim;
- Nara Firmware preserves XiaoZhi-derived MIT material under a separate
  third-party MIT notice while Nara-authored firmware additions remain under
  Nara's proprietary terms.

Reason:

The project owner wants the source visible without granting the broad
use/modification/redistribution rights that define open-source licensing.
Using an OSI license or PolyForm Strict would grant more rights than intended.
