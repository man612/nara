import type { ToolCall, ToolResult } from "../actions/contracts.js";
import type { FirmwareSessionInfo } from "../gateway.js";

export type FirmwareVoiceControl = {
  sendText(text: string): Promise<void>;
  executeTool(call: ToolCall): Promise<ToolResult>;
  interrupt(): Promise<void>;
};

type Entry = {
  session: FirmwareSessionInfo;
  control: FirmwareVoiceControl;
  connectedAt: number;
};

export class FirmwareVoiceControlRegistry {
  private readonly bySession = new Map<string, Entry>();

  register(
    session: FirmwareSessionInfo,
    control: FirmwareVoiceControl
  ): void {
    this.bySession.set(session.sessionId, {
      session,
      control,
      connectedAt: Date.now()
    });
  }

  unregister(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  list(): Array<{
    sessionId: string;
    deviceId?: string;
    clientId?: string;
    connectedAt: number;
  }> {
    return [...this.bySession.values()]
      .sort((a, b) => b.connectedAt - a.connectedAt)
      .map(({ session, connectedAt }) => ({
        sessionId: session.sessionId,
        ...(session.deviceId ? { deviceId: session.deviceId } : {}),
        ...(session.clientId ? { clientId: session.clientId } : {}),
        connectedAt
      }));
  }

  resolve(targetDeviceId?: string): Entry | undefined {
    const entries = [...this.bySession.values()];
    if (targetDeviceId) {
      return entries
        .filter((entry) => entry.session.deviceId === targetDeviceId)
        .sort((a, b) => b.connectedAt - a.connectedAt)[0];
    }

    if (entries.length === 1) {
      return entries[0];
    }

    return entries.sort((a, b) => b.connectedAt - a.connectedAt)[0];
  }

  async sendText(
    text: string,
    targetDeviceId?: string
  ): Promise<boolean> {
    const entry = this.resolve(targetDeviceId);
    if (!entry) return false;
    await entry.control.sendText(text);
    return true;
  }

  async executeTool(
    call: ToolCall,
    targetDeviceId?: string
  ): Promise<ToolResult | undefined> {
    const entry = this.resolve(targetDeviceId);
    if (!entry) return undefined;
    return entry.control.executeTool(call);
  }

  async interrupt(targetDeviceId?: string): Promise<boolean> {
    const entry = this.resolve(targetDeviceId);
    if (!entry) return false;
    await entry.control.interrupt();
    return true;
  }
}
