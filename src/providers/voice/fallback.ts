import type {
  AudioChunk,
  VoiceConnectOptions,
  VoiceEventHandler,
  VoiceProvider,
  VoiceSession,
  VoiceSessionEvent
} from "../../contracts/providers.js";
import type { ToolResult } from "../../actions/contracts.js";

export type VoiceProviderCandidate = {
  id: string;
  create: () => VoiceProvider;
};

type ConnectedCandidate = {
  index: number;
  id: string;
  session: VoiceSession;
};

export class FallbackVoiceProvider implements VoiceProvider {
  readonly id: string;

  constructor(
    id: string,
    private readonly candidates: VoiceProviderCandidate[]
  ) {
    if (candidates.length === 0) {
      throw new Error("FallbackVoiceProvider needs at least one candidate");
    }
    this.id = id;
  }

  async connect(options?: VoiceConnectOptions): Promise<VoiceSession> {
    const initial = await connectCandidates(
      this.candidates,
      this.candidates.map((_, index) => index),
      options,
      "All voice providers failed"
    );

    return new RecoveringVoiceSession(
      this.candidates,
      options,
      initial
    );
  }
}

async function connectCandidates(
  candidates: VoiceProviderCandidate[],
  order: number[],
  options: VoiceConnectOptions | undefined,
  failurePrefix: string
): Promise<ConnectedCandidate> {
  const failures: string[] = [];

  for (const index of order) {
    const candidate = candidates[index]!;
    try {
      const provider = candidate.create();
      const session = await provider.connect(options);
      return { index, id: candidate.id, session };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      failures.push(`${candidate.id}: ${message}`);
    }
  }

  throw new Error(`${failurePrefix}: ${failures.join(" | ")}`);
}

class RecoveringVoiceSession implements VoiceSession {
  private readonly handlers = new Set<VoiceEventHandler>();
  private current: ConnectedCandidate | null;
  private currentUnsubscribe: (() => void) | null = null;
  private generation = 0;
  private closed = false;
  private disconnected = false;
  private recoveryAllowed = true;
  private disconnectReason = "";
  private recovering: Promise<void> | null = null;
  private readonly pendingToolCallIds = new Set<string>();
  private outputActive = false;

  constructor(
    private readonly candidates: VoiceProviderCandidate[],
    private readonly options: VoiceConnectOptions | undefined,
    initial: ConnectedCandidate
  ) {
    this.current = initial;
    this.attach(initial);
  }

  subscribe(handler: VoiceEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async sendAudio(chunk: AudioChunk): Promise<void> {
    const session = await this.ensureInputSession();
    await session.sendAudio(chunk);
  }

  async sendText(text: string): Promise<void> {
    const session = await this.ensureInputSession();
    if (!session.sendText) {
      throw new Error(
        "Recovered voice provider does not support text injection"
      );
    }
    await session.sendText(text);
  }

  async endAudioStream(): Promise<void> {
    if (this.closed) return;
    if (this.disconnected || !this.current) {
      // Never create a fresh provider merely to send the end marker for audio
      // that belonged to a dead provider. The next actual user input recovers.
      return;
    }
    await this.current.session.endAudioStream?.();
  }

  async sendToolResult(result: ToolResult): Promise<void> {
    if (this.closed || this.disconnected || !this.current) {
      return;
    }
    if (!this.current.session.sendToolResult) {
      throw new Error(
        "Current voice provider cannot receive tool results"
      );
    }
    await this.current.session.sendToolResult(result);
    if (result.callId) {
      this.pendingToolCallIds.delete(result.callId);
    }
  }

  async interrupt(): Promise<void> {
    if (this.closed || this.disconnected || !this.current) return;
    await this.current.session.interrupt();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.currentUnsubscribe?.();
    this.currentUnsubscribe = null;

    const recovery = this.recovering;
    if (recovery) {
      await recovery.catch(() => undefined);
    }

    const current = this.current;
    this.current = null;
    this.pendingToolCallIds.clear();
    this.handlers.clear();

    await current?.session.close().catch(() => undefined);
  }

  private attach(connected: ConnectedCandidate): void {
    if (this.closed) {
      void connected.session.close().catch(() => undefined);
      return;
    }

    this.currentUnsubscribe?.();
    this.current = connected;
    this.disconnected = false;
    this.recoveryAllowed = true;
    this.disconnectReason = "";
    this.generation += 1;
    const generation = this.generation;

    this.currentUnsubscribe = connected.session.subscribe(
      async (event) => {
        if (this.closed || generation !== this.generation) {
          return;
        }
        await this.handleInnerEvent(event, connected, generation);
      }
    );
  }

  private async handleInnerEvent(
    event: VoiceSessionEvent,
    connected: ConnectedCandidate,
    generation: number
  ): Promise<void> {
    if (generation !== this.generation || this.closed) return;

    switch (event.type) {
      case "tool.call":
        if (event.callId) {
          this.pendingToolCallIds.add(event.callId);
        }
        break;
      case "tool.cancel":
        for (const callId of event.callIds) {
          this.pendingToolCallIds.delete(callId);
        }
        break;
      case "output.started":
        this.outputActive = true;
        break;
      case "output.completed":
      case "interrupted":
        this.outputActive = false;
        break;
      case "session.disconnected":
        await this.markDisconnected(connected, event);
        return;
      case "session.recovered":
        // Native providers do not currently emit this; nested recovery events
        // are ignored so only this supervisor owns cross-provider recovery.
        return;
      default:
        break;
    }

    await this.emit(event);
  }

  private async markDisconnected(
    connected: ConnectedCandidate,
    event: Extract<
      VoiceSessionEvent,
      { type: "session.disconnected" }
    >
  ): Promise<void> {
    if (
      this.closed ||
      this.disconnected ||
      this.current?.session !== connected.session
    ) {
      return;
    }

    this.disconnected = true;
    this.recoveryAllowed = event.recoverable;
    this.disconnectReason = event.reason;
    this.currentUnsubscribe?.();
    this.currentUnsubscribe = null;

    const callIds = [...this.pendingToolCallIds];
    this.pendingToolCallIds.clear();
    if (callIds.length > 0) {
      await this.emit({ type: "tool.cancel", callIds });
    }

    if (this.outputActive) {
      this.outputActive = false;
      await this.emit({ type: "interrupted" });
    }

    await this.emit(event);

    // Do not block the provider's own socket event loop while cleaning up.
    void connected.session.close().catch(() => undefined);
  }

  private async ensureInputSession(): Promise<VoiceSession> {
    if (this.closed) {
      throw new Error("Fallback voice session is closed");
    }
    if (!this.disconnected && this.current) {
      return this.current.session;
    }
    if (!this.recoveryAllowed) {
      throw new Error(
        `Voice session ended and is not safely recoverable: ${this.disconnectReason}`
      );
    }

    if (!this.recovering) {
      this.recovering = this.recover().finally(() => {
        this.recovering = null;
      });
    }
    await this.recovering;

    if (!this.current || this.disconnected) {
      throw new Error("Voice recovery did not produce a live session");
    }
    return this.current.session;
  }

  private async recover(): Promise<void> {
    const previous = this.current;
    const previousId = previous?.id ?? "unknown";
    const previousIndex = previous?.index ?? -1;

    // Provider-native recovery already had its chance before a provider emits
    // session.disconnected. Prefer the next configured provider, then wrap
    // around and retry the previous provider last. With one candidate this
    // naturally reconnects that same provider.
    const order = Array.from(
      { length: this.candidates.length },
      (_, offset) =>
        (previousIndex + 1 + offset) % this.candidates.length
    );

    const connected = await connectCandidates(
      this.candidates,
      order,
      this.options,
      "Voice recovery failed"
    );

    if (this.closed) {
      await connected.session.close().catch(() => undefined);
      throw new Error("Fallback voice session closed during recovery");
    }

    this.attach(connected);
    await this.emit({
      type: "session.recovered",
      fromProviderId: previousId,
      toProviderId: connected.id
    });
  }

  private async emit(event: VoiceSessionEvent): Promise<void> {
    for (const handler of [...this.handlers]) {
      await handler(event);
    }
  }
}
