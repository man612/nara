import type { FirmwareVoiceControlRegistry } from "../device/voice-control.js";
import type { HermesAgentClient } from "../agents/hermes.js";

type TelegramUser = {
  id?: number;
};

type TelegramChat = {
  id?: number;
};

type TelegramMessage = {
  message_id?: number;
  text?: string;
  from?: TelegramUser;
  chat?: TelegramChat;
};

type TelegramUpdate = {
  update_id?: number;
  message?: TelegramMessage;
};

type TelegramResponse<T> = {
  ok?: boolean;
  result?: T;
  description?: string;
};

export type TelegramBridgeOptions = {
  botToken: string;
  allowedUserIds: number[];
  voiceControls: FirmwareVoiceControlRegistry;
  targetDeviceId?: string;
  hermes?: HermesAgentClient;
  statusText?: () => Promise<string> | string;
  fetchImpl?: typeof fetch;
  pollTimeoutSeconds?: number;
};

function parseCommand(
  text: string
): { command: string; argument: string } {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return { command: "ask", argument: trimmed };
  }
  const space = trimmed.indexOf(" ");
  const raw =
    space === -1 ? trimmed.slice(1) : trimmed.slice(1, space);
  const command = raw.split("@")[0]!.toLocaleLowerCase();
  return {
    command,
    argument: space === -1 ? "" : trimmed.slice(space + 1).trim()
  };
}

export class TelegramBridge {
  private readonly fetchImpl: typeof fetch;
  private readonly allowed = new Set<number>();
  private readonly pendingChats: number[] = [];
  private offset = 0;
  private stopped = false;
  private polling: Promise<void> | undefined;

  constructor(private readonly options: TelegramBridgeOptions) {
    if (!options.botToken.trim()) {
      throw new Error("Telegram bot token is required");
    }
    if (options.allowedUserIds.length === 0) {
      throw new Error("Telegram allowlist must not be empty");
    }
    for (const id of options.allowedUserIds) {
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new Error("Telegram user IDs must be positive integers");
      }
      this.allowed.add(id);
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  start(): void {
    if (this.polling) return;
    this.stopped = false;
    this.polling = this.loop().finally(() => {
      this.polling = undefined;
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.polling;
  }

  async handleOutputTranscript(
    text: string,
    final: boolean
  ): Promise<void> {
    if (!final || !text.trim()) return;
    const chatId = this.pendingChats.shift();
    if (chatId === undefined) return;
    await this.sendMessage(chatId, text.trim());
  }

  async pollOnce(signal?: AbortSignal): Promise<number> {
    const updates = await this.callApi<TelegramUpdate[]>(
      "getUpdates",
      {
        offset: this.offset,
        timeout: this.options.pollTimeoutSeconds ?? 25,
        allowed_updates: ["message"]
      },
      signal
    );

    for (const update of updates) {
      if (
        typeof update.update_id === "number" &&
        update.update_id >= this.offset
      ) {
        this.offset = update.update_id + 1;
      }
      await this.handleUpdate(update);
    }
    return updates.length;
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    await this.callApi(
      "sendMessage",
      {
        chat_id: chatId,
        text: trimmed.slice(0, 4096)
      }
    );
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (this.stopped) break;
        console.error("[telegram] polling failed", error);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    const userId = message?.from?.id;
    const chatId = message?.chat?.id;
    const text = message?.text;
    if (
      !message ||
      typeof userId !== "number" ||
      typeof chatId !== "number" ||
      typeof text !== "string"
    ) {
      return;
    }

    if (!this.allowed.has(userId)) {
      console.warn("[telegram] ignored unauthorized user", userId);
      return;
    }

    const { command, argument } = parseCommand(text);
    switch (command) {
      case "start":
      case "help":
        await this.sendMessage(
          chatId,
          [
            "Nara Telegram bridge ready.",
            "/ask <pesan> - ngobrol lewat Nara",
            "/say <pesan> - minta Nara membacakan pesan",
            "/notify <pesan> - notifikasi lokal tanpa AI",
            "/agent <tugas> - delegasikan tugas panjang ke Hermes",
            "/status - status singkat"
          ].join("\\n")
        );
        return;

      case "status":
        await this.sendMessage(
          chatId,
          this.options.statusText
            ? await this.options.statusText()
            : this.defaultStatus()
        );
        return;

      case "notify": {
        if (!argument) {
          await this.sendMessage(chatId, "Tulis pesan setelah /notify.");
          return;
        }
        const result = await this.options.voiceControls.executeTool(
          {
            name: "device_companion",
            arguments: {
              op: "notify",
              text: argument,
              emotion: "happy",
              sound: "builtin:popup"
            },
            callId: "telegram-notify-" + Date.now()
          },
          this.options.targetDeviceId
        );
        await this.sendMessage(
          chatId,
          result?.ok
            ? "Notifikasi dikirim ke Nara."
            : "Nara belum online atau fitur notifikasi belum tersedia."
        );
        return;
      }

      case "say": {
        if (!argument) {
          await this.sendMessage(chatId, "Tulis pesan setelah /say.");
          return;
        }
        const delivered = await this.options.voiceControls.sendText(
          "Read this message to the person near the device exactly and briefly, without adding new facts: " +
            JSON.stringify(argument),
          this.options.targetDeviceId
        );
        await this.sendMessage(
          chatId,
          delivered
            ? "Pesan dikirim ke suara Nara."
            : "Nara belum punya sesi suara aktif."
        );
        return;
      }

      case "agent": {
        if (!argument) {
          await this.sendMessage(chatId, "Tulis tugas setelah /agent.");
          return;
        }
        if (!this.options.hermes) {
          await this.sendMessage(chatId, "Hermes belum dikonfigurasi.");
          return;
        }
        const run = await this.options.hermes.startRun({
          task: argument,
          idempotencyKey:
            "telegram-" + userId + "-" + (message.message_id ?? Date.now())
        });
        await this.sendMessage(
          chatId,
          "Hermes mulai mengerjakan. run_id=" +
            run.runId +
            " status=" +
            run.status
        );
        return;
      }

      case "ask": {
        if (!argument) return;
        const delivered = await this.options.voiceControls.sendText(
          argument,
          this.options.targetDeviceId
        );
        if (!delivered) {
          await this.sendMessage(chatId, "Nara belum punya sesi suara aktif.");
          return;
        }
        this.pendingChats.push(chatId);
        return;
      }

      default:
        await this.sendMessage(
          chatId,
          "Perintah belum dikenal. Coba /help."
        );
    }
  }

  private defaultStatus(): string {
    const sessions = this.options.voiceControls.list();
    const target = this.options.targetDeviceId
      ? sessions.find(
          (session) => session.deviceId === this.options.targetDeviceId
        )
      : sessions[0];
    return target
      ? "Nara online. session=" + target.sessionId
      : "Nara belum online.";
  }

  private async callApi<T = unknown>(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<T> {
    const response = await this.fetchImpl(
      "https://api.telegram.org/bot" +
        this.options.botToken +
        "/" +
        method,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {})
      }
    );
    if (!response.ok) {
      throw new Error(
        "Telegram " + method + " failed: HTTP " + response.status
      );
    }
    const payload = (await response.json()) as TelegramResponse<T>;
    if (!payload.ok || payload.result === undefined) {
      throw new Error(
        "Telegram " +
          method +
          " failed: " +
          (payload.description ?? "unknown error")
      );
    }
    return payload.result;
  }
}
