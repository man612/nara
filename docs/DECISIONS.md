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
