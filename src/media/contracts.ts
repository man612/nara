export type MediaTrack = {
  uri: string;
  title: string;
  artists: string[];
};

export type MediaCommand =
  | { op: "play" }
  | { op: "pause" }
  | { op: "next" }
  | { op: "previous" }
  | { op: "volume"; volume: number };

export interface MediaProvider {
  readonly id: string;
  control(command: MediaCommand, signal: AbortSignal): Promise<void>;
  searchTracks(
    query: string,
    limit: number,
    signal: AbortSignal
  ): Promise<MediaTrack[]>;
  playTrack(uri: string, signal: AbortSignal): Promise<void>;
}
