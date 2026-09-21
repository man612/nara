export type VoiceLatencySample = {
  sessionId: string;
  deviceId?: string;
  providerFirstAudioMs: number;
  deviceFirstPacketMs: number;
  recordedAt: string;
};

export type VoiceLatencySummary = {
  count: number;
  providerFirstAudioMs?: { p50: number; p95: number };
  deviceFirstPacketMs?: { p50: number; p95: number };
};

function percentile(values: number[], fraction: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1)
  );
  return Math.round(sorted[index]!);
}

export class VoiceLatencyMonitor {
  private readonly samples: VoiceLatencySample[] = [];

  constructor(private readonly maxSamples = 200) {}

  record(sample: VoiceLatencySample): void {
    if (
      sample.providerFirstAudioMs < 0 ||
      sample.deviceFirstPacketMs < sample.providerFirstAudioMs
    ) {
      return;
    }
    this.samples.push(sample);
    if (this.samples.length > this.maxSamples) {
      this.samples.splice(0, this.samples.length - this.maxSamples);
    }
  }

  summary(deviceId?: string): VoiceLatencySummary {
    const relevant = deviceId
      ? this.samples.filter((sample) => sample.deviceId === deviceId)
      : this.samples;
    const provider = relevant.map((sample) => sample.providerFirstAudioMs);
    const device = relevant.map((sample) => sample.deviceFirstPacketMs);
    const providerP50 = percentile(provider, 0.5);
    const providerP95 = percentile(provider, 0.95);
    const deviceP50 = percentile(device, 0.5);
    const deviceP95 = percentile(device, 0.95);

    return {
      count: relevant.length,
      ...(providerP50 !== undefined && providerP95 !== undefined
        ? {
            providerFirstAudioMs: {
              p50: providerP50,
              p95: providerP95
            }
          }
        : {}),
      ...(deviceP50 !== undefined && deviceP95 !== undefined
        ? {
            deviceFirstPacketMs: {
              p50: deviceP50,
              p95: deviceP95
            }
          }
        : {})
    };
  }

  latest(deviceId?: string): VoiceLatencySample | undefined {
    for (let index = this.samples.length - 1; index >= 0; --index) {
      const sample = this.samples[index]!;
      if (!deviceId || sample.deviceId === deviceId) return sample;
    }
    return undefined;
  }
}
