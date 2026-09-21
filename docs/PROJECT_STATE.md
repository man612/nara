# Project state

This file is Nara's durable project checkpoint for humans and coding agents.

Read it after `docs/REPO_MAP.md`. Update it after any meaningful implementation batch that changes what is finished, what is next, or what is blocked. Do not rely on a chat transcript as the only record of project direction.

Last reviewed: 2026-09-21  
Baseline before this document: `e02be087ce6873406ff32a9e5461b7cb2d336a69`

## Product direction

Nara is a provider-neutral runtime for expressive physical AI companions.

The first real deployment is a companion device intended for a trusted partner. That is a launch profile, not a core architectural assumption. Nara must remain reusable for multiple people, households, characters, devices, and relationships.

The public repository uses role names such as `owner`, `partner`, and `guest`. Real names, biographies, relationship details, private conversations, credentials, and personal memories belong in runtime-private storage, not Git.

## What is already real

Server/runtime:

- physical firmware WebSocket handshake and Opus framing;
- session-scoped Opus/PCM transcoding;
- production `libopus-wasm` codec adapter;
- Gemini Live realtime voice adapter;
- connect-time voice-provider fallback;
- bounded playback pacing and interruption handling;
- provider-neutral Action Runtime;
- safe device actions through the firmware MCP compatibility layer;
- normalized provider usage fields for token/cost accounting;
- automated unit/integration coverage including a real-Opus firmware voice vertical slice;
- typed connectivity capability contract separating cloud gateway, local gateway, direct peer and isolated modes;
- persistent device lifecycle/claim registry with one-time device-bound claims, account + physical approval gates, hashed per-device credentials, rotation/revocation and gateway enforcement;
- provider-neutral multi-person directory with exactly one primary person, up to six enrolled speaker profiles, and guest fallback;
- conservative speaker-identity service contract that requires calibrated confidence + margin thresholds and never defaults an ambiguous voice to the primary person;
- first file-backed personal-memory store with subject/viewer-aware recall, explicit sharing, expiry, edit/delete, bounded retrieval, and persistence tests.

Firmware:

- standalone `man612/nara-firmware` repository;
- Waveshare ESP32-S3-Touch-LCD-1.85B as the first target;
- target builds in CI;
- Nara face engine integrated into the target runtime;
- inherited XiaoZhi lineage pinned/documented instead of remaining a GitHub fork.

## Current phase

The transport, voice, provider, and first action vertical slices are far enough along that the next architectural priority is **identity + personal knowledge + context selection**.

Do not expand into many unrelated tools before a minimal memory/context path exists.

Offline usefulness is now a core product requirement. The current firmware does not yet provide a real offline product mode; no-network startup still tends toward Wi-Fi configuration and cloud conversation depends on a reachable gateway. See `docs/OFFLINE_RUNTIME.md` and `docs/PHONE_CONNECTIVITY.md`.

Physical personality is also local-first. The server contract already has semantic touch/IMU event shapes, while the physical 1.85B firmware still needs a real CST816S/QMI8658 bridge and gesture classifiers. See `docs/PHYSICAL_INTERACTIONS.md`.

## Immediate work order

### P0 — durable project context

Status: complete in `feat/project-memory-foundation`.

- project checkpoint lives in the repository;
- decisions/research/hardware state have durable docs;
- coding agents are instructed to read/update them;
- filled personal profiles remain outside Git.

### P1 — local personal-memory vertical slice

Status: privacy/context boundary implemented; realtime voice integration and production person-directory persistence remain.

Implemented in this branch:

- typed personal fact model;
- stable subject IDs;
- viewer-aware recall;
- explicit per-fact `shareWith`;
- public/private/trusted/household labels;
- expiry;
- relevance cap;
- persistent local JSON file adapter under the memory boundary;
- edit/delete by stable fact ID;
- tests for partner, guest, restart persistence, expiry, and bounded recall;
- Zod validation for writes and persisted records;
- explicit PersonalContextComposer/PersonalBrainService boundary;
- least-privilege known-person viewer resolver;
- provider-capture tests proving unauthorized facts never enter a brain request;
- versioned file format that rejects unknown/invalid snapshots instead of silently migrating them.

Still required before P1 is complete:

- persist the production person/account directory in runtime-private storage;
- wire the authenticated viewer/subject selection into an actual user-facing text path;
- then integrate the same policy boundary into realtime voice transcript/context composition;
- define an explicit migration tool before changing memory file version 1.

First end-to-end scenario remains:

> A trusted partner asks Nara a question about the owner. Nara retrieves only owner facts explicitly shareable with that partner and answers from those facts.

### P2 — identity and context composer

Status: device identity/credential foundation implemented; human account authentication, viewer resolution and context composition remain.

Implemented identity foundation:

- persistent runtime-private device registry;
- `unclaimed -> claim_pending -> active/revoked` lifecycle;
- one-time expiring claim transaction;
- separate account approval and physical approval gates;
- per-device credential issuance, hashing, rotation and revocation;
- active/revoked enforcement at the firmware WebSocket edge;
- legacy fleet token cannot impersonate an active device.

Separate:

- Nara/character identity ("who the companion is");
- person profile ("who the humans are");
- durable memory ("what has been learned");
- project instructions ("how contributors build Nara").

Build a context composer that selects the smallest relevant subset instead of concatenating all memory.

### P3 — offline runtime foundation

Status: foundation started; phone/connectivity architecture and typed degradation contract are implemented, device-side offline behavior is not yet implemented.

Implemented foundation:

- connectivity capability vocabulary: `online`, `local_gateway`, `peer_only`, `isolated`;
- provisioning transports are distinct from runtime links;
- phone connection hierarchy documented: Wi-Fi station/hotspot first, on-demand SoftAP direct peer, BLE/DPP for provisioning/on-demand roles;
- tests lock the connectivity degradation priority.

Next offline milestones:

- wire connectivity status independently from interaction state in firmware;
- useful no-network startup instead of a setup dead-end;
- local clock/timer/alarm/status/navigation;
- local physical reflex engine for touch/IMU;
- authorized offline personal capsule;
- reconnect/sync behavior;
- direct-phone SoftAP + authenticated local web mode;
- production provisioning migration/validation (DPP + secure BLE/SoftAP);
- later local-network STT/brain/TTS.

Do not promise unrestricted Indonesian STT/TTS on ESP32 alone; official ESP-SR command recognition is Chinese/English and its embedded TTS is Chinese-only.

See `docs/OFFLINE_RUNTIME.md`.

### P4 — memory in conversation

Status: text-path privacy proof complete; guest/public realtime memory retrieval implemented behind the Action Runtime.

Implemented:

- text-path context composition after access filtering;
- realtime `personal_memory_search` tool exposed through the provider-neutral Action Runtime;
- realtime memory viewer/subject are fixed server-side, not chosen by the model;
- current voice path deliberately uses `person:guest`, so it can retrieve only public facts until strong viewer authentication is wired;
- memory search results are compact and omit access-policy metadata.

Still required:

- bind a strong authenticated viewer signal from phone/account/physical approval into each voice session;
- then allow trusted/private memory according to the same existing access policy;
- add transcript -> memory-candidate review/normalization before durable writes;
- keep raw transcripts optional and short-lived rather than storing every utterance forever.

### P5 — hardware-in-the-loop validation

Buy/use the target board and validate:

- microphone capture;
- echo cancellation;
- speaker playback;
- interruption/barge-in;
- touch controller raw coordinates and gesture behavior;
- IMU axis/orientation mapping;
- pet/stroke classifier;
- face-down/upside-down classifier;
- shake/spin/knock classification and false-positive testing;
- pickup/set-down inference;
- sustained thermals/performance;
- Wi-Fi reliability;
- battery behavior if a battery is fitted;
- physical ES7210 mic/reference channel mapping;
- one-mic versus two-mic AFE path;
- input gain/clipping;
- AEC mode/NLP tuning;
- noise-suppression/AGC experiments;
- voice recognition under quiet/noisy/near/far conditions;
- audio regression after the final enclosure is fitted.

Do not treat voice identity as a hard dependency: recognition failure must downgrade permissions/fall back to touch or phone confirmation rather than making the device unusable.

See `docs/HARDWARE_PLAN.md`, `docs/AUDIO_ROBUSTNESS.md`, and `docs/PHYSICAL_INTERACTIONS.md`.

### P6 — external knowledge and delegation

After memory/context is trustworthy:

- web/search adapter;
- optional Hermes delegation;
- additional voice providers;
- reminders/calendar/home automation where useful.

### P7 — multi-person experience

Status: person-directory and speaker-identity decision foundation implemented; real provider adapter/enrollment and session integration remain.

Implemented:

- exactly one primary person per device/profile directory;
- explicit creator/household/trusted/guest roles;
- up to six enabled enrolled voice profiles, with unlimited unknown people falling back to guest;
- provider-neutral speaker recognition contract;
- confidence + runner-up margin gates so ambiguous audio becomes unknown instead of being forced to the primary person;
- minimum-audio gate so very short utterances do not waste recognition compute;
- speaker recognition remains personalization evidence only and does not elevate private-memory authorization.

Still required:

- benchmark real speaker providers on Waveshare microphone audio (3D-Speaker/SpeechBrain/Picovoice candidates);
- implement enrollment/re-enrollment/delete lifecycle;
- bind low-risk personalization to recognized speaker;
- bind strong phone/account/physical authentication separately for private-memory privilege;
- add per-person preferences and proactive behavior;
- validate household cross-talk, TV/replay audio, noisy rooms and false accept/reject behavior;
- multiple devices/profiles without cloning the core runtime.

## Known connectivity security blocker

The inherited hotspot provisioning path from `78/esp-wifi-connect ~3.3.1` currently uses an open SoftAP and HTTP configuration portal. It is acceptable only as a development/reference path.

Before direct-phone peer mode can expose any private capsule/media/account data, Nara needs a separate authenticated peer surface with protected Wi-Fi and application/session authorization. Production Wi-Fi credential provisioning should migrate toward DPP or ESP-IDF Unified/Network Provisioning Security 2.

See `docs/PHONE_CONNECTIVITY.md`.

## Open decisions

These are intentionally not treated as solved yet:

- whether the first file-backed memory adapter remains the default or is replaced by a database;
- encryption-at-rest implementation and key ownership;
- how a device authenticates a trusted partner versus a guest;
- exact server-side speaker-recognition provider/thresholds; voice match is only a confidence/personalization signal, not root authentication;
- whether the 1.85B can and should expose both physical speech microphones plus playback reference to AFE after hardware validation;
- import UX for large personal histories;
- retention policy for raw transcripts;
- how proactive speech should differ by viewer/profile;
- exact local-network STT/TTS/LLM provider choices for Indonesian;
- exact offline-capsule storage/index format and removable-media encryption scheme;
- calibrated physical-gesture thresholds and whether body-wide capacitive touch is worth extra hardware later.

When one of these becomes a real architectural decision, record it in `docs/DECISIONS.md`.

## Checkpoint discipline

At the end of a meaningful implementation batch:

1. update the "What is already real" section if capabilities changed;
2. move completed priority items forward instead of leaving stale TODOs;
3. record blockers or unresolved risks;
4. add architecture decisions to `docs/DECISIONS.md`;
5. add significant external research to `docs/RESEARCH_SOURCES.md`;
6. update `docs/HARDWARE_PLAN.md` if the buy/test state changed;
7. keep README status truthful.

A coding agent should be able to open the repository tomorrow and reconstruct the current direction without reading the conversation that produced it.
