import type {
  ToolCall,
  ToolDefinition,
  ToolProvider,
  ToolResult
} from "../actions/contracts.js";
import type { MediaProvider } from "./contracts.js";

const TOOL_NAME = "media_control";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class MediaToolProvider implements ToolProvider {
  readonly id: string;

  constructor(private readonly media: MediaProvider) {
    this.id = `media:${media.id}`;
  }

  async listTools(): Promise<ToolDefinition[]> {
    return [
      {
        name: TOOL_NAME,
        description:
          "Control music playback or search tracks on the configured media service. " +
          "Use search_play when the user directly asks to play a named song.",
        inputSchema: {
          type: "object",
          properties: {
            op: {
              type: "string",
              enum: [
                "play",
                "pause",
                "next",
                "previous",
                "volume",
                "search",
                "search_play"
              ]
            },
            query: { type: "string", minLength: 1, maxLength: 300 },
            volume: { type: "integer", minimum: 0, maximum: 100 }
          },
          required: ["op"],
          additionalProperties: false
        },
        effect: "write"
      }
    ];
  }

  async callTool(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    try {
      if (call.name !== TOOL_NAME || !isRecord(call.arguments)) {
        return this.failure(call, "Invalid media_control call");
      }
      const op = call.arguments.op;
      if (typeof op !== "string") {
        return this.failure(call, "op is required");
      }

      if (op === "search" || op === "search_play") {
        const query = call.arguments.query;
        if (typeof query !== "string" || !query.trim()) {
          return this.failure(call, "query is required for search");
        }
        const tracks = await this.media.searchTracks(query, 5, signal);
        if (tracks.length === 0) {
          return this.success(call, { matches: [] });
        }
        if (op === "search_play") {
          await this.media.playTrack(tracks[0]!.uri, signal);
        }
        return this.success(call, {
          ...(op === "search_play"
            ? { played: { title: tracks[0]!.title, artists: tracks[0]!.artists } }
            : {}),
          matches: tracks.map((track) => ({
            title: track.title,
            artists: track.artists,
            uri: track.uri
          }))
        });
      }

      if (op === "volume") {
        const volume = call.arguments.volume;
        if (!Number.isInteger(volume)) {
          return this.failure(call, "volume is required for volume control");
        }
        await this.media.control({ op: "volume", volume: volume as number }, signal);
        return this.success(call, { volume });
      }

      if (!["play", "pause", "next", "previous"].includes(op)) {
        return this.failure(call, `Unsupported media operation: ${op}`);
      }
      await this.media.control(
        { op: op as "play" | "pause" | "next" | "previous" },
        signal
      );
      return this.success(call, { op });
    } catch (error) {
      return this.failure(
        call,
        error instanceof Error ? error.message : "Media operation failed"
      );
    }
  }

  private success(call: ToolCall, value: unknown): ToolResult {
    return {
      name: call.name,
      ok: true,
      ...(call.callId ? { callId: call.callId } : {}),
      value,
      scheduling: "silent"
    };
  }

  private failure(call: ToolCall, error: string): ToolResult {
    return {
      name: call.name,
      ok: false,
      ...(call.callId ? { callId: call.callId } : {}),
      error,
      scheduling: "silent"
    };
  }
}
