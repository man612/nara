import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type PersonalMemorySensitivity =
  | "private"
  | "trusted"
  | "household"
  | "public";

export type PersonalMemorySource = {
  type: "manual" | "conversation" | "import" | "tool";
  reference?: string;
};

export type PersonalMemoryFact = {
  id: string;
  subjectId: string;
  kind: string;
  text: string;
  tags?: string[];
  source: PersonalMemorySource;
  confidence?: number;
  sensitivity: PersonalMemorySensitivity;
  shareWith?: string[];
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
};

export type PersonalMemoryQuery = {
  viewerId: string;
  subjectId: string;
  query: string;
  limit?: number;
  now?: string;
};

export interface PersonalMemoryStore {
  upsert(fact: PersonalMemoryFact): Promise<void>;
  remove(id: string): Promise<boolean>;
  recall(query: PersonalMemoryQuery): Promise<PersonalMemoryFact[]>;
}

type PersistedMemory = {
  version: 1;
  facts: PersonalMemoryFact[];
};

const DEFAULT_RECALL_LIMIT = 5;
const MAX_RECALL_LIMIT = 20;

export function canViewerAccessFact(
  fact: PersonalMemoryFact,
  viewerId: string
): boolean {
  if (fact.subjectId === viewerId) return true;
  if (fact.sensitivity === "public") return true;
  return fact.shareWith?.includes(viewerId) ?? false;
}

function tokenize(value: string): string[] {
  return value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function factScore(fact: PersonalMemoryFact, rawQuery: string): number {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (!query) return 1;

  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return 1;

  const haystack = [
    fact.kind,
    fact.text,
    ...(fact.tags ?? [])
  ].join(" ").toLocaleLowerCase();

  let score = haystack.includes(query) ? 4 : 0;
  for (const term of terms) {
    if (haystack.includes(term)) score += 1;
  }

  return score;
}

function isExpired(fact: PersonalMemoryFact, now: number): boolean {
  if (!fact.expiresAt) return false;
  const expiresAt = Date.parse(fact.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

function normalizedLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_RECALL_LIMIT;
  }

  return Math.min(MAX_RECALL_LIMIT, Math.max(1, Math.trunc(limit)));
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export class FilePersonalMemoryStore implements PersonalMemoryStore {
  private facts: Map<string, PersonalMemoryFact> | undefined;
  private loadPromise: Promise<void> | undefined;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async upsert(fact: PersonalMemoryFact): Promise<void> {
    await this.ensureLoaded();
    this.facts!.set(fact.id, fact);
    await this.persist();
  }

  async remove(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const removed = this.facts!.delete(id);
    if (removed) await this.persist();
    return removed;
  }

  async recall(query: PersonalMemoryQuery): Promise<PersonalMemoryFact[]> {
    await this.ensureLoaded();

    const now = query.now ? Date.parse(query.now) : Date.now();
    const effectiveNow = Number.isFinite(now) ? now : Date.now();
    const limit = normalizedLimit(query.limit);

    return [...this.facts!.values()]
      .filter((fact) => fact.subjectId === query.subjectId)
      .filter((fact) => !isExpired(fact, effectiveNow))
      .filter((fact) => canViewerAccessFact(fact, query.viewerId))
      .map((fact) => ({ fact, score: factScore(fact, query.query) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const updated = b.fact.updatedAt.localeCompare(a.fact.updatedAt);
        if (updated !== 0) return updated;
        return a.fact.id.localeCompare(b.fact.id);
      })
      .slice(0, limit)
      .map(({ fact }) => fact);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.facts) return;

    if (!this.loadPromise) {
      this.loadPromise = this.load();
    }

    await this.loadPromise;
  }

  private async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedMemory>;

      if (parsed.version !== 1 || !Array.isArray(parsed.facts)) {
        throw new Error("Unsupported personal memory file format");
      }

      this.facts = new Map(
        parsed.facts.map((fact) => [fact.id, fact] as const)
      );
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        this.facts = new Map();
        return;
      }

      throw error;
    }
  }

  private async persist(): Promise<void> {
    const snapshot: PersistedMemory = {
      version: 1,
      facts: [...this.facts!.values()]
    };

    const payload = JSON.stringify(snapshot, null, 2) + "\n";
    const directory = dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;

    const write = this.writeQueue.then(async () => {
      await mkdir(directory, { recursive: true });
      await writeFile(temporaryPath, payload, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    });

    this.writeQueue = write.catch(() => undefined);
    await write;
  }
}
