# Personal knowledge and multi-person memory

Nara should be able to know a lot about its owner while still being safe to use by a partner, household member, or guest.

This is not one giant prompt and it is not one giant `MEMORY.md` file.

## The core model

Keep four concepts separate:

1. **Companion identity** — who Nara/the active character is, how it speaks, and its stable behavioral principles.
2. **People** — who the humans are and their relationships/roles.
3. **Personal knowledge** — facts, preferences, stories, routines, and memories about those people.
4. **Conversation state** — the short-lived context of the current interaction.

Project-development instructions remain in `AGENTS.md` and `docs/`; they are not runtime personality or human memory.

This separation is inspired by the useful distinction made by modern agent runtimes such as Hermes between agent identity, user profile, learned memory, and project instructions. Nara should implement the concepts behind that split without depending on Hermes.

## First deployment, future architecture

The first intended real-world profile is a companion for a trusted partner.

Example question:

> "What kind of work does the owner usually do?"

Nara may answer from stored facts about the owner **only if those facts are allowed to be shared with the current viewer**.

The architecture must not encode "partner" as the only possible viewer. Later there may be:

- owner;
- partner;
- family/household member;
- friend;
- guest;
- multiple companion devices;
- multiple profiles or characters.

## Identity vocabulary

Use stable machine IDs rather than names as primary keys.

Example:

```text
person:owner
person:partner
person:guest
```

Real names and personal details live in private runtime data.

A viewer is the person currently using/asking Nara.

A subject is the person/entity a stored fact is about.

They can be different:

```text
viewer  = person:partner
subject = person:owner
question = "What food does the owner like?"
```

## Personal fact shape

A durable fact should carry metadata instead of being stored as an anonymous sentence.

Conceptual record:

```json
{
  "id": "fact_...",
  "subjectId": "person:owner",
  "kind": "preference",
  "text": "The owner prefers ...",
  "tags": ["food"],
  "source": {
    "type": "manual",
    "reference": "onboarding"
  },
  "confidence": 1.0,
  "sensitivity": "personal",
  "shareWith": ["person:owner", "person:partner"],
  "createdAt": "...",
  "updatedAt": "..."
}
```

The exact storage schema can evolve, but these semantics should survive provider/storage changes.

## Permission rule: filter before the model

Do not retrieve private facts and then ask the LLM not to reveal them.

The safe flow is:

```text
question
  -> resolve viewer
  -> resolve subject/query
  -> retrieve candidate facts
  -> apply access policy
  -> rank/cap relevant allowed facts
  -> inject only allowed facts into model context
  -> answer
```

Unauthorized content must never enter the model context for that request.

If viewer identity is unknown, default to the least-privileged `guest` policy.

## Suggested sharing levels

The first implementation can stay small:

- `private` — owner only;
- `trusted` — explicitly selected trusted people;
- `household` — known household members;
- `public` — safe for any viewer.

Per-fact explicit `shareWith` should override broad relationship defaults when supported.

Never store passwords, API keys, recovery codes, payment secrets, or equivalent credentials as "memory".

## What "put everything about me in Nara" should mean

It should mean building a curated personal knowledge base, not dumping every byte of a person's digital history into every prompt.

Useful categories:

- basic biography;
- work and skills;
- preferences and dislikes;
- routines and habits;
- important people and relationships;
- stories and personal timeline;
- interests and hobbies;
- practical information the companion should know;
- things the owner wants the partner to be able to ask;
- private owner-only context;
- temporary facts with an expiry date.

Large sources should be imported, normalized, deduplicated, and split into facts/notes with provenance.

Potential import sources later:

- guided onboarding questionnaire;
- owner-written profile;
- selected documents;
- selected chat exports;
- calendar/contact context where explicitly connected;
- memories learned during conversation after policy/consent checks.

Raw source material should not automatically become permanent memory.

## Storage boundary

Personal runtime data must not be committed to this public repository.

Use a private runtime location under `data/` or an equivalent mounted volume. `data/` is gitignored.

A future deployment may use a local single-file database or PostgreSQL behind the same `MemoryProvider` boundary. Storage choice must not change the device protocol.

Recommended properties:

- encryption at rest where practical;
- backups controlled by the owner;
- explicit export/delete;
- fact provenance;
- timestamps and optional expiry;
- structured metadata plus optional semantic/vector index;
- canonical text remains readable/editable even if embeddings are rebuilt.

## Context-budget rule

Memory retrieval must be small.

For each request:

- retrieve a handful of strong candidates;
- filter by viewer permission;
- rank for relevance;
- deduplicate;
- cap total characters/tokens;
- prefer structured summaries over full historical transcripts.

Do not send an entire biography or memory database when the question needs one fact.

## Initial viewer identity

Do not make voice biometrics a prerequisite for the first version.

For the first partner device, a safer/simple approach is a trusted device/profile pairing or explicit active profile. Unknown users fall back to guest.

Voice identification can be researched later, but false identification must not accidentally grant access to private facts.

## Functional acceptance tests

The personal-memory layer is not done until tests prove at least:

1. owner facts can be saved and recalled;
2. partner-shareable facts are visible to `person:partner`;
3. owner-private facts are not returned to `person:partner`;
4. guest sees neither private nor trusted-only facts;
5. an unauthorized fact is removed before building the model prompt;
6. retrieval returns only a small capped context;
7. facts can be edited/deleted;
8. storage survives a process restart.


## Implemented context boundary

The first implementation now treats access filtering as a hard code boundary rather than a prompt convention.

Flow:

```text
authenticated/verified viewer signal
        |
        v
KnownPersonResolver
        |
        | unknown / voice-only guess -> guest
        v
PersonalMemoryStore.recall()
        |
        | subject + expiry + access policy + relevance + limit
        v
authorized facts only
        |
        v
PersonalContextComposer
        |
        v
BrainProvider
```

Important constraints:

- the persisted JSON file is validated before records are accepted;
- writes are validated before persistence;
- unknown/invalid file versions fail closed rather than being silently trusted;
- speaker recognition alone does not elevate a viewer for personal-memory access;
- the context composer receives only the store's already-filtered recall result;
- tests capture the actual downstream brain request and assert that unauthorized marker text is absent;
- memory text is serialized as reference data and explicitly marked as data rather than instructions.

The current file format remains version 1. A future storage-format change must ship with an explicit migration path; do not silently reinterpret unknown versions.


## Realtime voice retrieval

Realtime voice uses the same access boundary without dumping the memory database into the live session prompt.

```text
Gemini/voice provider
       |
       | optional tool call: personal_memory_search(query)
       v
Action Runtime
       |
       v
PersonalMemoryToolProvider
       |
       | viewerId + subjectId fixed by server
       v
PersonalMemoryStore.recall()
       |
       | expiry + subject + access + relevance + limit
       v
compact authorized facts only
       |
       v
tool result back to voice provider
```

The model cannot choose `viewerId` or `subjectId`. Extra identity-like arguments are ignored because identity is a server/session concern.

Current production bootstrap is intentionally conservative: firmware authentication proves which physical Nara connected, not which human is speaking. Until a strong viewer signal is supplied by authenticated account/phone/physical confirmation, realtime voice binds the viewer to `person:guest`. That means only public facts are eligible.

This avoids two unsafe shortcuts:

- treating ownership of a device as proof that every nearby speaker is the owner/partner;
- treating speaker-recognition confidence as authorization for private memory.

Trusted/private realtime recall should be enabled only after the session has a stronger authenticated viewer identity.


## Remote creator-authored content

Personal knowledge is runtime data, not firmware. A creator should be able to update facts they intentionally share without rebuilding or reflashing the ESP32.

The first deployable HTTP edge is deliberately narrow:

- bearer-authenticated;
- bound server-side to one author/subject ID;
- share targets restricted to a configured viewer allowlist;
- public publishing disabled unless explicitly enabled;
- fact IDs generated inside the contributor namespace;
- delete/update operations cannot escape that namespace;
- no LLM call is involved in create/update/list/delete.

This is a bootstrap management surface, not the final passkey/account UI. Production deployment must terminate HTTPS before exposing it over the Internet. A later authenticated account layer can replace the bearer credential without changing the underlying PersonalContentService policy boundary.

Example flow:

```text
creator phone/web
  -> authenticated HTTPS
  -> scoped PersonalContentService
  -> validated PersonalMemoryStore
  -> immediately available to authorized online recall
  -> later selected into an offline capsule
```

The creator credential must not grant access to the recipient's unrelated private memories or to device-admin/security operations.
