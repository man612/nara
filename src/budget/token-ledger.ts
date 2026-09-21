export type TokenBudgetLevel = "ok" | "low" | "critical" | "exhausted";

export type DailyTokenBudgetSnapshot = {
  localDate: string;
  usedTokens: number;
  limitTokens: number;
  remainingTokens: number;
  percentUsed: number;
  level: TokenBudgetLevel;
};

export type DailyTokenBudgetUpdate = DailyTokenBudgetSnapshot & {
  changedLevel: boolean;
};

function dateKey(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return value("year") + "-" + value("month") + "-" + value("day");
}

export class DailyTokenBudget {
  private activeDate: string;
  private used = 0;
  private level: TokenBudgetLevel = "ok";
  private readonly streams = new Map<string, number>();

  constructor(
    private readonly options: {
      limitTokens: number;
      lowFraction?: number;
      criticalFraction?: number;
      timeZone?: string;
      now?: () => Date;
    }
  ) {
    if (
      !Number.isSafeInteger(options.limitTokens) ||
      options.limitTokens <= 0
    ) {
      throw new Error("Daily token limit must be a positive integer");
    }
    const low = options.lowFraction ?? 0.8;
    const critical = options.criticalFraction ?? 0.95;
    if (
      low <= 0 ||
      low >= 1 ||
      critical <= low ||
      critical > 1
    ) {
      throw new Error(
        "Token budget fractions require 0 < low < critical <= 1"
      );
    }
    const zone = options.timeZone ?? "UTC";
    new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(new Date());
    this.activeDate = dateKey(this.now(), zone);
  }

  recordCumulative(
    streamId: string,
    totalTokens: number
  ): DailyTokenBudgetUpdate {
    if (!streamId.trim()) {
      throw new Error("Token budget stream ID is required");
    }
    if (!Number.isFinite(totalTokens) || totalTokens < 0) {
      throw new Error("Cumulative token count must be non-negative");
    }
    this.rollDate();

    const normalized = Math.floor(totalTokens);
    const previous = this.streams.get(streamId);
    let delta = normalized;
    if (previous !== undefined) {
      // Providers usually report cumulative session usage. If the counter
      // unexpectedly decreases, treat it as a reset instead of subtracting.
      delta =
        normalized >= previous
          ? normalized - previous
          : normalized;
    }
    this.streams.set(streamId, normalized);
    this.used += delta;

    const previousLevel = this.level;
    this.level = this.computeLevel();
    return {
      ...this.snapshot(),
      changedLevel: previousLevel !== this.level
    };
  }

  forgetStream(streamId: string): void {
    this.streams.delete(streamId);
  }

  snapshot(): DailyTokenBudgetSnapshot {
    this.rollDate();
    const remaining = Math.max(0, this.options.limitTokens - this.used);
    return {
      localDate: this.activeDate,
      usedTokens: this.used,
      limitTokens: this.options.limitTokens,
      remainingTokens: remaining,
      percentUsed: Math.min(
        100,
        (this.used / this.options.limitTokens) * 100
      ),
      level: this.level
    };
  }

  private rollDate(): void {
    const current = dateKey(
      this.now(),
      this.options.timeZone ?? "UTC"
    );
    if (current === this.activeDate) return;
    this.activeDate = current;
    this.used = 0;
    this.level = "ok";
    this.streams.clear();
  }

  private computeLevel(): TokenBudgetLevel {
    const ratio = this.used / this.options.limitTokens;
    if (ratio >= 1) return "exhausted";
    if (ratio >= (this.options.criticalFraction ?? 0.95)) {
      return "critical";
    }
    if (ratio >= (this.options.lowFraction ?? 0.8)) {
      return "low";
    }
    return "ok";
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }
}
