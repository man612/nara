# Private personal profile template

This file is a **template only**. Do not fill it with real personal data and commit it to this public repository.

When the personal-memory importer exists, copy/fill this structure in private runtime storage under `data/` or through the onboarding UI.

The goal is not to force every detail into one prompt. The goal is to give Nara a curated source from which it can create structured facts with provenance and sharing rules.

## Person

- stable id: `person:owner`
- display name:
- preferred name/nickname:
- pronouns if relevant:
- languages:
- home region/timezone if useful:
- short self-description:

## Biography and timeline

For each important item, include approximate dates when known.

- birthplace/background:
- education:
- places lived:
- important life events:
- achievements:
- difficult/important experiences the owner intentionally wants Nara to know:
- current life stage:

## Work and skills

- current work:
- previous work:
- technical skills:
- non-technical skills:
- current projects:
- tools/software commonly used:
- recurring work problems:
- career goals:

## Interests and preferences

- hobbies:
- technology interests:
- music:
- films/shows:
- books:
- games:
- food/drinks:
- favorite places:
- style/aesthetic preferences:
- things strongly disliked:
- communication preferences:

## Routines and practical context

- common schedule:
- sleep/wake pattern if intentionally shared:
- commute/travel habits:
- devices/equipment commonly used:
- recurring errands:
- important dates/reminders:
- useful practical instructions:

## Important people

Use stable person IDs rather than using a name as the database key.

For each person:

- person id:
- display name:
- relationship:
- important context:
- what Nara may share with this person:
- what Nara must not share with this person:

## Relationship context

Information intentionally useful to the companion/partner experience:

- shared memories:
- inside jokes:
- favorite activities together:
- important dates:
- preferences in communication:
- things the owner wants Nara to help the partner understand:
- things that should stay owner-only:

## Stories and memories

Use one story per section/item.

For each:

- title:
- approximate date:
- people involved:
- story:
- why it matters:
- tags:
- share level:
- expiry date if temporary:

## Sharing labels

Every imported fact should end up with an access policy.

Suggested labels:

- `private` — owner only;
- `trusted` — explicitly selected trusted person(s);
- `household` — known household members;
- `public` — safe for any viewer.

For the first partner deployment, explicitly mark facts that may be shared with `person:partner`.

## Never put in memory

Do not use Nara personal memory as a password manager.

Do not store:

- passwords;
- API keys;
- recovery codes;
- card CVV/PIN;
- private keys/seed phrases;
- authentication cookies/tokens;
- secrets whose disclosure would directly grant account or financial access.

## Import notes

When importing a large source later:

- preserve source/provenance;
- extract durable facts instead of saving every sentence forever;
- keep uncertainty when a fact is inferred rather than explicitly stated;
- deduplicate conflicting facts;
- prefer latest valid information while retaining history when useful;
- allow the owner to edit/delete/export the result.
