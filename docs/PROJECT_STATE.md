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

## Immediate work order

### P0 — durable project context

Status: complete in `feat/project-memory-foundation`.

- project checkpoint lives in the repository;
- decisions/research/hardware state have durable docs;
- coding agents are instructed to read/update them;
- filled personal profiles remain outside Git.

### P1 — local personal-memory vertical slice

Status: started.

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
- tests for partner, guest, restart persistence, expiry, and bounded recall.

Still required before P1 is complete:

- choose/wire the runtime-private storage path under `data/`;
- validate stored records instead of trusting arbitrary file JSON;
- expose a small service/context API rather than wiring the file adapter directly into voice;
- add a known-person/viewer resolver;
- prove unauthorized facts cannot reach a brain request;
- decide migration strategy if the first file format is replaced later.

First end-to-end scenario remains:

> A trusted partner asks Nara a question about the owner. Nara retrieves only owner facts explicitly shareable with that partner and answers from those facts.

### P2 — identity and context composer

Separate:

- Nara/character identity ("who the companion is");
- person profile ("who the humans are");
- durable memory ("what has been learned");
- project instructions ("how contributors build Nara").

Build a context composer that selects the smallest relevant subset instead of concatenating all memory.

### P3 — memory in conversation

- text-path integration first because it is easier to test deterministically;
- then voice transcript -> memory candidate -> retrieval -> answer;
- keep raw transcripts optional and short-lived;
- summarize/normalize durable facts instead of storing every utterance forever.

### P4 — hardware-in-the-loop validation

Buy/use the target board and validate:

- microphone capture;
- echo cancellation;
- speaker playback;
- interruption/barge-in;
- touch;
- IMU orientation;
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

See `docs/HARDWARE_PLAN.md` and `docs/AUDIO_ROBUSTNESS.md`.

### P5 — external knowledge and delegation

After memory/context is trustworthy:

- web/search adapter;
- optional Hermes delegation;
- additional voice providers;
- reminders/calendar/home automation where useful.

### P6 — multi-person experience

- multiple known people;
- trusted/guest roles;
- per-person preferences and memories;
- sharing policies;
- optional identity/pairing methods;
- multiple devices/profiles without cloning the core runtime.

## Open decisions

These are intentionally not treated as solved yet:

- whether the first file-backed memory adapter remains the default or is replaced by a database;
- encryption-at-rest implementation and key ownership;
- how a device authenticates a trusted partner versus a guest;
- exact server-side speaker-recognition provider/thresholds; voice match is only a confidence/personalization signal, not root authentication;
- whether the 1.85B can and should expose both physical speech microphones plus playback reference to AFE after hardware validation;
- import UX for large personal histories;
- retention policy for raw transcripts;
- how proactive speech should differ by viewer/profile.

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
