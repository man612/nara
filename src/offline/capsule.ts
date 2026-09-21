import { createHash } from "node:crypto";
import { z } from "zod";
import {
  canViewerAccessFact,
  FilePersonalMemoryStore,
  type PersonalMemoryFact
} from "../memory/personal.js";

const MAX_CAPSULE_FACTS = 64;
const MAX_TEXT_LENGTH = 640;
const MAX_ALIASES_PER_FACT = 16;

export const OfflineCapsuleFactSchema = z.object({
  id: z.string().min(1).max(128),
  kind: z.string().min(1).max(64),
  text: z.string().min(1).max(MAX_TEXT_LENGTH),
  aliases: z.array(z.string().min(1).max(64)).max(MAX_ALIASES_PER_FACT)
});

export const OfflineCapsulePayloadSchema = z.object({
  version: z.literal(1),
  recipientPersonId: z.string().min(1).max(128),
  subjectPersonId: z.string().min(1).max(128),
  generatedAt: z.string().datetime({ offset: true }),
  facts: z.array(OfflineCapsuleFactSchema).max(MAX_CAPSULE_FACTS)
});

export const OfflineCapsuleSchema = OfflineCapsulePayloadSchema.extend({
  revision: z.string().regex(/^[a-f0-9]{64}$/)
});

export type OfflineCapsule = z.infer<typeof OfflineCapsuleSchema>;

function tokenize(value: string): string[] {
  return value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function aliasesFor(fact: PersonalMemoryFact): string[] {
  const values = [
    fact.kind,
    ...(fact.tags ?? []),
    ...tokenize(fact.kind),
    ...(fact.tags ?? []).flatMap(tokenize)
  ];

  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const raw of values) {
    const value = raw.trim().toLocaleLowerCase();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    aliases.push(value.slice(0, 64));
    if (aliases.length >= MAX_ALIASES_PER_FACT) break;
  }
  return aliases;
}

function isExpired(fact: PersonalMemoryFact, nowMs: number): boolean {
  if (!fact.expiresAt) return false;
  const expiresAt = Date.parse(fact.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= nowMs;
}

function canonicalPayload(payload: z.infer<typeof OfflineCapsulePayloadSchema>): string {
  return JSON.stringify(payload);
}

export async function compileOfflineCapsule(options: {
  store: FilePersonalMemoryStore;
  recipientPersonId: string;
  subjectPersonId: string;
  now?: Date;
  maxFacts?: number;
}): Promise<OfflineCapsule> {
  const recipientPersonId = options.recipientPersonId.trim();
  const subjectPersonId = options.subjectPersonId.trim();
  if (!recipientPersonId || !subjectPersonId) {
    throw new Error("Offline capsule recipient and subject are required");
  }

  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Offline capsule now must be a valid date");
  }

  const requestedLimit = options.maxFacts ?? MAX_CAPSULE_FACTS;
  const limit = Math.max(
    1,
    Math.min(MAX_CAPSULE_FACTS, Math.trunc(requestedLimit))
  );

  const candidates = await options.store.listBySubject(subjectPersonId);
  const facts = candidates
    .filter((fact) => !isExpired(fact, now.getTime()))
    .filter((fact) => canViewerAccessFact(fact, recipientPersonId))
    .slice(0, limit)
    .map((fact) =>
      OfflineCapsuleFactSchema.parse({
        id: fact.id,
        kind: fact.kind,
        text: fact.text.slice(0, MAX_TEXT_LENGTH),
        aliases: aliasesFor(fact)
      })
    )
    .sort((a, b) => a.id.localeCompare(b.id));

  const payload = OfflineCapsulePayloadSchema.parse({
    version: 1,
    recipientPersonId,
    subjectPersonId,
    generatedAt: now.toISOString(),
    facts
  });

  const revision = createHash("sha256")
    .update(canonicalPayload(payload), "utf8")
    .digest("hex");

  return OfflineCapsuleSchema.parse({
    ...payload,
    revision
  });
}

export function capsuleSearch(
  capsule: OfflineCapsule,
  query: string,
  limit = 5
): OfflineCapsule["facts"] {
  const terms = [...new Set(tokenize(query))];
  const normalized = query.trim().toLocaleLowerCase();
  const boundedLimit = Math.max(1, Math.min(10, Math.trunc(limit)));

  return capsule.facts
    .map((fact) => {
      const haystack = [
        fact.kind,
        fact.text,
        ...fact.aliases
      ].join(" ").toLocaleLowerCase();
      let score = normalized && haystack.includes(normalized) ? 4 : 0;
      for (const term of terms) {
        if (haystack.includes(term)) score += 1;
      }
      return { fact, score: terms.length === 0 ? 1 : score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.fact.id.localeCompare(b.fact.id);
    })
    .slice(0, boundedLimit)
    .map(({ fact }) => fact);
}
