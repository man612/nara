import { randomUUID } from "node:crypto";
import type {
  FilePersonalMemoryStore,
  PersonalMemoryFact
} from "../memory/personal.js";

export type PersonalContentVisibility = "shared" | "public";

export type PersonalContentDraft = {
  id?: string;
  kind: string;
  text: string;
  tags?: string[];
  visibility?: PersonalContentVisibility;
  shareWith?: string[];
  expiresAt?: string;
};

export type PersonalContentPolicy = {
  subjectId: string;
  allowedViewerIds: string[];
  defaultViewerIds?: string[];
  allowPublic?: boolean;
  now?: () => number;
};

const MAX_TEXT_LENGTH = 8_000;
const MAX_KIND_LENGTH = 80;
const MAX_TAG_LENGTH = 80;
const MAX_TAGS = 32;

function requireText(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new Error(`${field} must be 1..${maxLength} characters`);
  }
  return normalized;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

export class PersonalContentService {
  private readonly allowedViewerIds: Set<string>;
  private readonly defaultViewerIds: string[];
  private readonly now: () => number;
  private readonly idPrefix: string;

  constructor(
    private readonly store: FilePersonalMemoryStore,
    private readonly policy: PersonalContentPolicy
  ) {
    this.policy.subjectId = requireText(policy.subjectId, "subjectId", 256);
    this.allowedViewerIds = new Set(
      uniqueStrings(
        policy.allowedViewerIds.map((viewerId) =>
          requireText(viewerId, "allowedViewerId", 256)
        )
      )
    );
    this.defaultViewerIds = uniqueStrings(
      (policy.defaultViewerIds ?? []).map((viewerId) =>
        requireText(viewerId, "defaultViewerId", 256)
      )
    );

    for (const viewerId of this.defaultViewerIds) {
      if (!this.allowedViewerIds.has(viewerId)) {
        throw new Error(
          `Default viewer ${viewerId} is not in allowedViewerIds`
        );
      }
    }

    this.now = policy.now ?? Date.now;
    this.idPrefix = `content:${this.policy.subjectId}:`;
  }

  async upsert(draft: PersonalContentDraft): Promise<PersonalMemoryFact> {
    const kind = requireText(draft.kind, "kind", MAX_KIND_LENGTH);
    const text = requireText(draft.text, "text", MAX_TEXT_LENGTH);
    const tags = draft.tags
      ? uniqueStrings(
          draft.tags.map((tag) => requireText(tag, "tag", MAX_TAG_LENGTH))
        )
      : undefined;
    if (tags && tags.length > MAX_TAGS) {
      throw new Error(`At most ${MAX_TAGS} tags are allowed`);
    }

    const visibility = draft.visibility ?? "shared";
    if (visibility === "public" && !this.policy.allowPublic) {
      throw new Error("Public content is disabled for this contributor");
    }

    let shareWith: string[] | undefined;
    if (visibility === "shared") {
      shareWith = uniqueStrings(draft.shareWith ?? this.defaultViewerIds);
      if (shareWith.length === 0) {
        throw new Error("Shared content requires at least one viewer");
      }
      for (const viewerId of shareWith) {
        if (!this.allowedViewerIds.has(viewerId)) {
          throw new Error(`Viewer ${viewerId} is outside contributor scope`);
        }
      }
    }

    const id = draft.id ?? `${this.idPrefix}${randomUUID()}`;
    if (!id.startsWith(this.idPrefix)) {
      throw new Error("Content ID is outside contributor scope");
    }

    const existing = await this.store.get(id);
    if (existing && existing.subjectId !== this.policy.subjectId) {
      throw new Error("Existing content belongs to another subject");
    }

    const now = new Date(this.now()).toISOString();
    const fact: PersonalMemoryFact = {
      id,
      subjectId: this.policy.subjectId,
      kind,
      text,
      source: {
        type: "manual",
        reference: "remote-personal-content"
      },
      sensitivity: visibility === "public" ? "public" : "trusted",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(tags ? { tags } : {}),
      ...(shareWith ? { shareWith } : {}),
      ...(draft.expiresAt ? { expiresAt: draft.expiresAt } : {})
    };

    await this.store.upsert(fact);
    return fact;
  }

  async list(): Promise<PersonalMemoryFact[]> {
    return this.store.listBySubject(this.policy.subjectId);
  }

  async remove(id: string): Promise<boolean> {
    if (!id.startsWith(this.idPrefix)) {
      throw new Error("Content ID is outside contributor scope");
    }
    const existing = await this.store.get(id);
    if (!existing) return false;
    if (existing.subjectId !== this.policy.subjectId) {
      throw new Error("Content belongs to another subject");
    }
    return this.store.remove(id);
  }
}
