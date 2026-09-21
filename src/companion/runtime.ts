import type { IncomingMessage } from "node:http";
import type { ToolProvider } from "../actions/contracts.js";
import {
  HermesAgentClient,
  HermesAgentToolProvider
} from "../agents/hermes.js";
import {
  BriefingService,
  DailyBriefingScheduler
} from "../briefing/service.js";
import { OpenMeteoWeatherClient } from "../briefing/weather.js";
import {
  DeepSeekBudgetSource,
  OpenRouterBudgetSource,
  ProviderBudgetMonitor,
  ProviderBudgetWatch,
  type ProviderBudgetSnapshot
} from "../budget/monitor.js";
import { CompanionStatusToolProvider } from "./tool-provider.js";
import { createNetworkDiagnosticsHttpHandler } from "../diagnostics/network-http.js";
import {
  FirmwareVoiceControlRegistry,
  type FirmwareVoiceControl
} from "../device/voice-control.js";
import type { FirmwareSessionInfo } from "../gateway.js";
import { TelegramBridge } from "../telegram/bridge.js";
import {
  VoiceLatencyMonitor,
  type VoiceLatencySample
} from "../telemetry/voice-latency.js";

function nonEmpty(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function numberEnv(name: string, fallback: number): number {
  const raw = nonEmpty(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(name + " must be a finite number");
  }
  return value;
}

function booleanEnv(name: string, fallback = false): boolean {
  const raw = nonEmpty(name);
  if (!raw) return fallback;
  if (raw.toLowerCase() === "true") return true;
  if (raw.toLowerCase() === "false") return false;
  throw new Error(name + " must be true or false");
}

function parseDailyTime(value: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) {
    throw new Error("NARA_DAILY_BRIEFING_TIME must use HH:MM");
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function parseUserIds(raw: string): number[] {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(
          "NARA_TELEGRAM_ALLOWED_USER_IDS must contain positive integer IDs"
        );
      }
      return parsed;
    });
}

export class CompanionRuntime {
  readonly voiceControls = new FirmwareVoiceControlRegistry();
  readonly latency = new VoiceLatencyMonitor();

  private hermes?: HermesAgentClient;
  private hermesTools?: HermesAgentToolProvider;
  private budgets?: ProviderBudgetMonitor;
  private budgetWatch?: ProviderBudgetWatch;
  private weather?: OpenMeteoWeatherClient;
  private telegram?: TelegramBridge;
  private dailyBriefing?: DailyBriefingScheduler;
  private targetDeviceId?: string;
  private briefingTimezone = "UTC";
  private started = false;

  static fromEnvironment(): CompanionRuntime {
    const runtime = new CompanionRuntime();
    runtime.configureFromEnvironment();
    return runtime;
  }

  toolProviders(deviceId?: string): ToolProvider[] {
    const briefing = this.createBriefing(deviceId);
    return [
      new CompanionStatusToolProvider({
        briefing,
        ...(this.weather ? { weather: this.weather } : {}),
        ...(this.budgets ? { budgets: this.budgets } : {}),
        latency: this.latency,
        ...(this.hermes ? { hermes: this.hermes } : {}),
        ...(deviceId ? { deviceId } : {})
      }),
      ...(this.hermesTools ? [this.hermesTools] : [])
    ];
  }

  registerVoiceControl(
    session: FirmwareSessionInfo,
    control: FirmwareVoiceControl
  ): void {
    this.voiceControls.register(session, control);
  }

  unregisterVoiceControl(session: FirmwareSessionInfo): void {
    this.voiceControls.unregister(session.sessionId);
  }

  recordLatency(sample: VoiceLatencySample): void {
    this.latency.record(sample);
  }

  async handleOutputTranscript(
    text: string,
    final: boolean
  ): Promise<void> {
    await this.telegram?.handleOutputTranscript(text, final);
  }

  networkDiagnosticsHandler(
    authorize: (request: IncomingMessage) => boolean
  ) {
    return createNetworkDiagnosticsHttpHandler({ authorize });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.telegram?.start();
    this.budgetWatch?.start();
    this.dailyBriefing?.start();
  }

  describeConfiguration(): string[] {
    const rows = [
      "Companion status:  latency telemetry enabled",
      ...(this.weather
        ? ["Weather:           deterministic Open-Meteo enabled"]
        : []),
      ...(this.budgets
        ? ["AI budget:         provider balance monitoring enabled"]
        : []),
      ...(this.hermes
        ? ["Hermes agent:      Runs API delegation enabled"]
        : []),
      ...(this.telegram
        ? ["Telegram:          allowlisted long-poll bridge enabled"]
        : []),
      ...(this.dailyBriefing
        ? [
            "Daily briefing:    " +
              (nonEmpty("NARA_DAILY_BRIEFING_TIME") ?? "") +
              " " +
              this.briefingTimezone
          ]
        : [])
    ];
    return rows;
  }

  private configureFromEnvironment(): void {
    this.targetDeviceId = nonEmpty("NARA_COMPANION_DEVICE_ID");

    const hermesKey = nonEmpty("HERMES_API_KEY");
    if (hermesKey) {
      this.hermes = new HermesAgentClient({
        baseUrl:
          nonEmpty("HERMES_BASE_URL") ?? "http://127.0.0.1:8642",
        apiKey: hermesKey,
        ...(nonEmpty("HERMES_PROFILE")
          ? { profile: nonEmpty("HERMES_PROFILE")! }
          : {})
      });
      this.hermesTools = new HermesAgentToolProvider(this.hermes, {
        ...(nonEmpty("HERMES_INSTRUCTIONS")
          ? { instructions: nonEmpty("HERMES_INSTRUCTIONS")! }
          : {}),
        ...(nonEmpty("HERMES_MODEL")
          ? { model: nonEmpty("HERMES_MODEL")! }
          : {}),
        ...(nonEmpty("HERMES_PROVIDER")
          ? { provider: nonEmpty("HERMES_PROVIDER")! }
          : {})
      });
    }

    const weatherValues = {
      latitude: nonEmpty("NARA_WEATHER_LATITUDE"),
      longitude: nonEmpty("NARA_WEATHER_LONGITUDE"),
      timezone: nonEmpty("NARA_WEATHER_TIMEZONE")
    };
    const weatherConfigured = Object.values(weatherValues).some(Boolean);
    if (weatherConfigured) {
      if (
        !weatherValues.latitude ||
        !weatherValues.longitude ||
        !weatherValues.timezone
      ) {
        throw new Error(
          "Weather requires NARA_WEATHER_LATITUDE, NARA_WEATHER_LONGITUDE, and NARA_WEATHER_TIMEZONE"
        );
      }
      this.weather = new OpenMeteoWeatherClient({
        latitude: Number(weatherValues.latitude),
        longitude: Number(weatherValues.longitude),
        timezone: weatherValues.timezone
      });
      this.briefingTimezone = weatherValues.timezone;
    }

    const lowUsd = numberEnv("NARA_AI_BUDGET_LOW_USD", 2);
    const criticalUsd = numberEnv("NARA_AI_BUDGET_CRITICAL_USD", 0.5);
    if (criticalUsd < 0 || lowUsd < criticalUsd) {
      throw new Error(
        "AI budget thresholds require low >= critical >= 0"
      );
    }

    const budgetSources = [];
    const deepSeekKey = nonEmpty("DEEPSEEK_API_KEY");
    if (deepSeekKey) {
      budgetSources.push(
        new DeepSeekBudgetSource(deepSeekKey, {
          low: lowUsd,
          critical: criticalUsd
        })
      );
    }
    const openRouterKey = nonEmpty("OPENROUTER_API_KEY");
    if (openRouterKey) {
      budgetSources.push(
        new OpenRouterBudgetSource(openRouterKey, {
          low: lowUsd,
          critical: criticalUsd
        })
      );
    }
    if (budgetSources.length > 0) {
      this.budgets = new ProviderBudgetMonitor(budgetSources);
      this.budgetWatch = new ProviderBudgetWatch(this.budgets, {
        intervalMs:
          Math.max(
            5,
            numberEnv("NARA_AI_BUDGET_CHECK_MINUTES", 30)
          ) *
          60_000,
        onChange: (snapshot) => this.handleBudgetWarning(snapshot)
      });
    }

    const telegramToken = nonEmpty("NARA_TELEGRAM_BOT_TOKEN");
    const telegramUsers = nonEmpty("NARA_TELEGRAM_ALLOWED_USER_IDS");
    if (telegramToken || telegramUsers) {
      if (!telegramToken || !telegramUsers) {
        throw new Error(
          "Telegram requires NARA_TELEGRAM_BOT_TOKEN and NARA_TELEGRAM_ALLOWED_USER_IDS"
        );
      }
      this.telegram = new TelegramBridge({
        botToken: telegramToken,
        allowedUserIds: parseUserIds(telegramUsers),
        voiceControls: this.voiceControls,
        ...(this.targetDeviceId
          ? { targetDeviceId: this.targetDeviceId }
          : {}),
        ...(this.hermes ? { hermes: this.hermes } : {}),
        statusText: () => this.telegramStatus()
      });
    }

    const dailyTime = nonEmpty("NARA_DAILY_BRIEFING_TIME");
    if (dailyTime) {
      const timezone =
        nonEmpty("NARA_DAILY_BRIEFING_TIMEZONE") ??
        weatherValues.timezone ??
        "UTC";
      this.briefingTimezone = timezone;
      const parsed = parseDailyTime(dailyTime);
      this.dailyBriefing = new DailyBriefingScheduler({
        ...parsed,
        timezone,
        onDue: () => this.deliverDailyBriefing()
      });
    }
  }

  private createBriefing(deviceId?: string): BriefingService {
    return new BriefingService({
      ...(this.weather ? { weather: this.weather } : {}),
      ...(this.budgets ? { budgets: this.budgets } : {}),
      latency: this.latency,
      ...(this.hermes ? { hermes: this.hermes } : {}),
      ...(deviceId ? { deviceId } : {})
    });
  }

  private async deliverDailyBriefing(): Promise<void> {
    const briefing = this.createBriefing(this.targetDeviceId);
    const snapshot = await briefing.snapshot();
    const summary = briefing.describeId(snapshot);
    const toolResult = await this.voiceControls.executeTool(
      {
        name: "device_companion",
        arguments: {
          op: "notify",
          text: summary.slice(0, 220),
          emotion: "happy",
          sound: "builtin:popup"
        },
        callId: "daily-briefing-" + Date.now()
      },
      this.targetDeviceId
    );

    if (!toolResult?.ok) {
      console.warn("[briefing] device notification unavailable");
    }

    if (booleanEnv("NARA_DAILY_BRIEFING_SPEAK", false)) {
      const delivered = await this.voiceControls.sendText(
        "Give this deterministic daily briefing naturally and briefly in Indonesian without adding facts: " +
          JSON.stringify(summary),
        this.targetDeviceId
      );
      if (!delivered) {
        console.warn("[briefing] voice session unavailable");
      }
    }
  }

  private async handleBudgetWarning(
    snapshot: ProviderBudgetSnapshot
  ): Promise<void> {
    const remaining =
      snapshot.remaining !== undefined
        ? " Sisa sekitar " +
          snapshot.remaining.toFixed(snapshot.remaining < 1 ? 2 : 1) +
          (snapshot.currency ? " " + snapshot.currency : "") +
          "."
        : "";
    const text =
      snapshot.level === "exhausted"
        ? snapshot.providerId + " habis atau tidak tersedia." + remaining
        : snapshot.level === "critical"
          ? snapshot.providerId + " sangat menipis." + remaining
          : snapshot.providerId + " mulai menipis." + remaining;

    const result = await this.voiceControls.executeTool(
      {
        name: "device_companion",
        arguments: {
          op: "notify",
          text: text.slice(0, 220),
          emotion:
            snapshot.level === "exhausted" ||
            snapshot.level === "critical"
              ? "sad"
              : "surprised",
          sound: "builtin:exclamation"
        },
        callId:
          "budget-" + snapshot.providerId + "-" + snapshot.level
      },
      this.targetDeviceId
    );
    if (!result?.ok) {
      console.warn("[budget] device warning unavailable", snapshot.providerId);
    }

    if (
      snapshot.level !== "exhausted" &&
      booleanEnv("NARA_AI_BUDGET_SPEAK_WARNINGS", false)
    ) {
      await this.voiceControls.sendText(
        "Say this short budget warning in Indonesian without adding anything: " +
          JSON.stringify(text),
        this.targetDeviceId
      );
    }
  }

  private async telegramStatus(): Promise<string> {
    const target = this.voiceControls.resolve(this.targetDeviceId);
    const briefing = this.createBriefing(this.targetDeviceId);
    const snapshot = await briefing.snapshot();
    return (
      (target
        ? "Nara online. "
        : "Nara belum punya sesi suara aktif. ") +
      briefing.describeId(snapshot)
    ).slice(0, 4096);
  }
}
