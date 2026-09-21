export type BudgetLevel = "ok" | "low" | "critical" | "exhausted";

export type ProviderBudgetSnapshot = {
  providerId: string;
  available: boolean;
  level: BudgetLevel;
  currency?: string;
  remaining?: number;
  usage?: number;
  limit?: number;
  checkedAt: string;
  detail?: string;
};

export interface ProviderBudgetSource {
  readonly id: string;
  read(signal?: AbortSignal): Promise<ProviderBudgetSnapshot>;
}

export type BalanceThresholds = {
  low: number;
  critical: number;
};

function levelFor(
  available: boolean,
  remaining: number | undefined,
  thresholds: BalanceThresholds
): BudgetLevel {
  if (!available || remaining === 0) return "exhausted";
  if (remaining === undefined) return "ok";
  if (remaining <= thresholds.critical) return "critical";
  if (remaining <= thresholds.low) return "low";
  return "ok";
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Budget API returned an invalid object");
  }
  return value as Record<string, unknown>;
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export class DeepSeekBudgetSource implements ProviderBudgetSource {
  readonly id = "deepseek";

  constructor(
    private readonly apiKey: string,
    private readonly thresholds: BalanceThresholds,
    private readonly options: {
      endpoint?: string;
      fetchImpl?: typeof fetch;
    } = {}
  ) {
    if (!apiKey.trim()) throw new Error("DeepSeek API key is required");
  }

  async read(signal?: AbortSignal): Promise<ProviderBudgetSnapshot> {
    const response = await (this.options.fetchImpl ?? fetch)(
      this.options.endpoint ?? "https://api.deepseek.com/user/balance",
      {
        headers: { authorization: "Bearer " + this.apiKey },
        signal
      }
    );
    if (!response.ok) {
      throw new Error("DeepSeek balance failed: HTTP " + response.status);
    }
    const root = asObject(await response.json());
    const infos = Array.isArray(root.balance_infos)
      ? root.balance_infos
      : [];
    const preferred =
      infos.find((item) => {
        try {
          return asObject(item).currency === "USD";
        } catch {
          return false;
        }
      }) ?? infos[0];
    const info = preferred ? asObject(preferred) : undefined;
    const remaining = info ? numeric(info.total_balance) : undefined;
    const currency =
      info && typeof info.currency === "string"
        ? info.currency
        : undefined;
    const available =
      typeof root.is_available === "boolean"
        ? root.is_available
        : (remaining ?? 0) > 0;

    return {
      providerId: this.id,
      available,
      level: levelFor(available, remaining, this.thresholds),
      ...(currency ? { currency } : {}),
      ...(remaining !== undefined ? { remaining } : {}),
      checkedAt: new Date().toISOString()
    };
  }
}

export class OpenRouterBudgetSource implements ProviderBudgetSource {
  readonly id = "openrouter";

  constructor(
    private readonly apiKey: string,
    private readonly thresholds: BalanceThresholds,
    private readonly options: {
      endpoint?: string;
      fetchImpl?: typeof fetch;
    } = {}
  ) {
    if (!apiKey.trim()) throw new Error("OpenRouter API key is required");
  }

  async read(signal?: AbortSignal): Promise<ProviderBudgetSnapshot> {
    const response = await (this.options.fetchImpl ?? fetch)(
      this.options.endpoint ?? "https://openrouter.ai/api/v1/key",
      {
        headers: { authorization: "Bearer " + this.apiKey },
        signal
      }
    );
    if (!response.ok) {
      throw new Error("OpenRouter key status failed: HTTP " + response.status);
    }
    const root = asObject(await response.json());
    const data =
      root.data && typeof root.data === "object"
        ? asObject(root.data)
        : root;
    const remaining = numeric(data.limit_remaining);
    const usage = numeric(data.usage);
    const limit = numeric(data.limit);
    const disabled = data.disabled === true;
    const available = !disabled && (remaining === undefined || remaining > 0);

    return {
      providerId: this.id,
      available,
      level: levelFor(available, remaining, this.thresholds),
      currency: "USD",
      ...(remaining !== undefined ? { remaining } : {}),
      ...(usage !== undefined ? { usage } : {}),
      ...(limit !== undefined ? { limit } : {}),
      checkedAt: new Date().toISOString(),
      ...(disabled ? { detail: "API key is disabled" } : {})
    };
  }
}

export class ProviderBudgetMonitor {
  constructor(private readonly sources: ProviderBudgetSource[]) {}

  async readAll(signal?: AbortSignal): Promise<ProviderBudgetSnapshot[]> {
    const results = await Promise.allSettled(
      this.sources.map((source) => source.read(signal))
    );
    return results.map((result, index) => {
      if (result.status === "fulfilled") return result.value;
      return {
        providerId: this.sources[index]!.id,
        available: false,
        level: "critical" as const,
        checkedAt: new Date().toISOString(),
        detail:
          result.reason instanceof Error
            ? result.reason.message
            : "budget check failed"
      };
    });
  }
}

export class ProviderBudgetWatch {
  private timer: NodeJS.Timeout | undefined;
  private readonly lastLevel = new Map<string, BudgetLevel>();
  private running = false;

  constructor(
    private readonly monitor: ProviderBudgetMonitor,
    private readonly options: {
      intervalMs: number;
      onChange: (
        snapshot: ProviderBudgetSnapshot
      ) => void | Promise<void>;
    }
  ) {}

  start(): void {
    if (this.timer) return;
    const tick = () => void this.check();
    this.timer = setInterval(tick, this.options.intervalMs);
    this.timer.unref?.();
    tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async check(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const snapshots = await this.monitor.readAll();
      for (const snapshot of snapshots) {
        const previous = this.lastLevel.get(snapshot.providerId);
        this.lastLevel.set(snapshot.providerId, snapshot.level);
        if (
          snapshot.level !== previous &&
          ["low", "critical", "exhausted"].includes(snapshot.level)
        ) {
          await this.options.onChange(snapshot);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
