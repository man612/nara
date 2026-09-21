import type {
  ProviderBudgetMonitor,
  ProviderBudgetSnapshot
} from "../budget/monitor.js";
import type {
  DailyTokenBudget,
  DailyTokenBudgetSnapshot
} from "../budget/token-ledger.js";
import type { HermesAgentClient } from "../agents/hermes.js";
import type {
  VoiceLatencyMonitor,
  VoiceLatencySummary
} from "../telemetry/voice-latency.js";
import {
  describeWeatherId,
  type OpenMeteoWeatherClient,
  type WeatherSnapshot
} from "./weather.js";

export type BriefingSnapshot = {
  weather?: WeatherSnapshot;
  budgets: ProviderBudgetSnapshot[];
  voiceTokenBudget?: DailyTokenBudgetSnapshot;
  latency: VoiceLatencySummary;
  hermesAvailable?: boolean;
  generatedAt: string;
};

export class BriefingService {
  constructor(
    private readonly options: {
      weather?: OpenMeteoWeatherClient;
      budgets?: ProviderBudgetMonitor;
      tokenBudget?: DailyTokenBudget;
      latency: VoiceLatencyMonitor;
      hermes?: HermesAgentClient;
      deviceId?: string;
    }
  ) {}

  async snapshot(signal?: AbortSignal): Promise<BriefingSnapshot> {
    const [weatherResult, budgetResult, hermesResult] =
      await Promise.allSettled([
        this.options.weather?.current(signal),
        this.options.budgets?.readAll(signal) ?? Promise.resolve([]),
        this.options.hermes?.health(signal)
      ]);

    return {
      ...(weatherResult.status === "fulfilled" && weatherResult.value
        ? { weather: weatherResult.value }
        : {}),
      budgets:
        budgetResult.status === "fulfilled"
          ? budgetResult.value
          : [],
      ...(this.options.tokenBudget
        ? { voiceTokenBudget: this.options.tokenBudget.snapshot() }
        : {}),
      latency: this.options.latency.summary(this.options.deviceId),
      ...(hermesResult.status === "fulfilled" &&
      hermesResult.value !== undefined
        ? { hermesAvailable: hermesResult.value }
        : {}),
      generatedAt: new Date().toISOString()
    };
  }

  describeId(snapshot: BriefingSnapshot): string {
    const parts: string[] = [];

    if (snapshot.weather) {
      parts.push(describeWeatherId(snapshot.weather));
    }

    const concerning = snapshot.budgets.filter(
      (budget) => budget.level !== "ok"
    );
    if (concerning.length > 0) {
      parts.push(
        "Status AI: " +
          concerning
            .map((budget) => {
              const remaining =
                budget.remaining !== undefined
                  ? " sisa " +
                    budget.remaining.toFixed(
                      budget.remaining < 1 ? 2 : 1
                    ) +
                    (budget.currency ? " " + budget.currency : "")
                  : "";
              return (
                budget.providerId +
                " " +
                this.budgetLevelId(budget.level) +
                remaining
              );
            })
            .join(", ") +
          "."
      );
    } else if (snapshot.budgets.length > 0) {
      parts.push("Budget AI yang dipantau masih aman.");
    }

    if (snapshot.voiceTokenBudget) {
      const token = snapshot.voiceTokenBudget;
      parts.push(
        "Budget token suara lokal hari ini terpakai " +
          Math.round(token.percentUsed) +
          " persen, sisa sekitar " +
          token.remainingTokens.toLocaleString("id-ID") +
          " token dari batas " +
          token.limitTokens.toLocaleString("id-ID") +
          "."
      );
    }

    if (snapshot.latency.deviceFirstPacketMs) {
      const p50 = snapshot.latency.deviceFirstPacketMs.p50;
      const p95 = snapshot.latency.deviceFirstPacketMs.p95;
      parts.push(
        "Respons suara terakhir yang terkumpul punya jeda tipikal sekitar " +
          this.describeLatencyMs(p50) +
          ", dan kondisi lambatnya sekitar " +
          this.describeLatencyMs(p95) +
          "."
      );
    }

    if (snapshot.hermesAvailable === false) {
      parts.push("Hermes sedang tidak bisa dihubungi.");
    }

    if (parts.length === 0) {
      return "Belum ada data laporan yang cukup.";
    }
    return parts.join(" ");
  }

  private budgetLevelId(level: ProviderBudgetSnapshot["level"]): string {
    switch (level) {
      case "low":
        return "mulai menipis";
      case "critical":
        return "sangat menipis";
      case "exhausted":
        return "habis atau tidak tersedia";
      default:
        return "aman";
    }
  }

  private describeLatencyMs(value: number): string {
    if (value < 500) return value + " milidetik, sangat cepat";
    if (value < 1000) return (value / 1000).toFixed(1) + " detik, cepat";
    if (value < 1800) return (value / 1000).toFixed(1) + " detik, cukup responsif";
    if (value < 3000) return (value / 1000).toFixed(1) + " detik, agak terasa";
    return (value / 1000).toFixed(1) + " detik, terasa lambat";
  }
}

export class DailyBriefingScheduler {
  private timer: NodeJS.Timeout | undefined;
  private lastLocalDate: string | undefined;

  constructor(
    private readonly options: {
      hour: number;
      minute: number;
      timezone: string;
      onDue: () => void | Promise<void>;
      now?: () => Date;
      intervalMs?: number;
    }
  ) {
    if (
      !Number.isInteger(options.hour) ||
      options.hour < 0 ||
      options.hour > 23 ||
      !Number.isInteger(options.minute) ||
      options.minute < 0 ||
      options.minute > 59
    ) {
      throw new Error("Daily briefing time is invalid");
    }
    new Intl.DateTimeFormat("en-CA", {
      timeZone: options.timezone,
      hour: "2-digit"
    }).format(new Date());
  }

  start(): void {
    if (this.timer) return;
    const tick = () => void this.check();
    this.timer = setInterval(
      tick,
      this.options.intervalMs ?? 30_000
    );
    this.timer.unref?.();
    tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async check(): Promise<void> {
    const now = (this.options.now ?? (() => new Date()))();
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: this.options.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(now);
    const value = (type: Intl.DateTimeFormatPartTypes): string =>
      parts.find((part) => part.type === type)?.value ?? "";
    const dateKey = value("year") + "-" + value("month") + "-" + value("day");
    const hour = Number(value("hour"));
    const minute = Number(value("minute"));

    if (
      hour !== this.options.hour ||
      minute !== this.options.minute ||
      this.lastLocalDate === dateKey
    ) {
      return;
    }

    this.lastLocalDate = dateKey;
    await this.options.onDue();
  }
}
