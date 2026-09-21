import { describe, expect, it } from "vitest";
import {
  MAX_ENROLLED_SPEAKERS,
  PersonDirectory,
  type PersonProfile
} from "../src/identity/directory.js";
import {
  SpeakerIdentityService,
  type SpeakerIdentityProvider
} from "../src/identity/speaker.js";

function baseProfiles(): PersonProfile[] {
  return [
    {
      personId: "person:rizma",
      displayName: "Rizma",
      role: "primary",
      accountIds: ["account:rizma"],
      speakerProfileId: "voice:rizma",
      speakerEnabled: true
    },
    {
      personId: "person:yasman",
      displayName: "Yasman",
      role: "creator",
      accountIds: ["account:yasman"],
      speakerProfileId: "voice:yasman",
      speakerEnabled: true,
      relationships: ["partner_of_primary"]
    },
    {
      personId: "person:mother",
      displayName: "Ibu",
      role: "household",
      speakerProfileId: "voice:mother",
      speakerEnabled: true
    }
  ];
}

class FakeSpeakerProvider implements SpeakerIdentityProvider {
  readonly id = "fake-speaker";

  constructor(
    private readonly scores: Array<{ profileId: string; score: number }>
  ) {}

  async identify() {
    return { scores: structuredClone(this.scores) };
  }
}

function audio(ms: number): { pcm16: Int16Array; sampleRate: number } {
  const sampleRate = 16_000;
  return {
    sampleRate,
    pcm16: new Int16Array(Math.ceil((sampleRate * ms) / 1000))
  };
}

const policy = {
  minConfidence: 0.8,
  minMargin: 0.08,
  minAudioMs: 700
};

describe("person directory", () => {
  it("keeps exactly one primary person while allowing several known speakers", () => {
    const directory = new PersonDirectory(baseProfiles());

    expect(directory.getPrimary()).toMatchObject({
      personId: "person:rizma",
      role: "primary"
    });
    expect(directory.getSpeakerCandidates()).toEqual([
      { personId: "person:rizma", profileId: "voice:rizma" },
      { personId: "person:yasman", profileId: "voice:yasman" },
      { personId: "person:mother", profileId: "voice:mother" }
    ]);
  });

  it("caps enrolled speaker profiles at the shared-device product limit", () => {
    const profiles: PersonProfile[] = Array.from(
      { length: MAX_ENROLLED_SPEAKERS + 1 },
      (_, index) => ({
        personId: `person:${index}`,
        displayName: `Person ${index}`,
        role: index === 0 ? "primary" : "household",
        speakerProfileId: `voice:${index}`,
        speakerEnabled: true
      })
    );

    expect(() => new PersonDirectory(profiles)).toThrow(/At most 6/);
  });
});

describe("speaker identity", () => {
  it("recognizes a known speaker only when confidence and separation both pass", async () => {
    const service = new SpeakerIdentityService(
      new FakeSpeakerProvider([
        { profileId: "voice:yasman", score: 0.93 },
        { profileId: "voice:rizma", score: 0.71 },
        { profileId: "voice:mother", score: 0.22 }
      ]),
      new PersonDirectory(baseProfiles()),
      policy
    );

    await expect(service.identify(audio(1200))).resolves.toEqual({
      kind: "known",
      personId: "person:yasman",
      confidence: 0.93,
      margin: 0.22000000000000008,
      providerId: "fake-speaker"
    });
  });

  it("returns unknown for ambiguous speakers instead of defaulting to the primary person", async () => {
    const service = new SpeakerIdentityService(
      new FakeSpeakerProvider([
        { profileId: "voice:rizma", score: 0.91 },
        { profileId: "voice:yasman", score: 0.88 }
      ]),
      new PersonDirectory(baseProfiles()),
      policy
    );

    await expect(service.identify(audio(1200))).resolves.toMatchObject({
      kind: "unknown",
      reason: "ambiguous"
    });
  });

  it("does not spend speaker-recognition work on audio below the configured minimum", async () => {
    let calls = 0;
    const provider: SpeakerIdentityProvider = {
      id: "counting",
      async identify() {
        calls += 1;
        return { scores: [] };
      }
    };

    const service = new SpeakerIdentityService(
      provider,
      new PersonDirectory(baseProfiles()),
      policy
    );

    await expect(service.identify(audio(200))).resolves.toMatchObject({
      kind: "unknown",
      reason: "audio_too_short"
    });
    expect(calls).toBe(0);
  });
});
