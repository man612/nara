import { describe, expect, it } from "vitest";
import type { AudioChunk } from "../src/contracts/providers.js";
import { HttpSpeakerIdentityProvider } from "../src/identity/speaker-http.js";
import { SpeakerTurnRecognizer } from "../src/identity/speaker-turn.js";
import type { SpeakerIdentityDecision } from "../src/identity/speaker.js";

function pcmChunk(samples: number, sampleRate = 1000): AudioChunk {
  const data = new Uint8Array(samples * 2);
  const view = new DataView(data.buffer);
  for (let index = 0; index < samples; index += 1) {
    view.setInt16(index * 2, index + 1, true);
  }
  return {
    format: "pcm16le",
    data,
    sampleRate,
    channels: 1
  };
}

describe("SpeakerTurnRecognizer", () => {
  it("runs one speaker inference at speech stop and keeps a bounded utterance", async () => {
    const calls: Array<{ samples: number; sampleRate: number }> = [];
    const decision: SpeakerIdentityDecision = {
      kind: "known",
      personId: "person:rizma",
      confidence: 0.94,
      margin: 0.22,
      providerId: "fake"
    };
    const recognizer = new SpeakerTurnRecognizer(
      {
        async identify(audio) {
          calls.push({
            samples: audio.pcm16.length,
            sampleRate: audio.sampleRate
          });
          return decision;
        }
      },
      {
        preRollMs: 200,
        maxUtteranceMs: 500
      }
    );

    recognizer.pushAudio(pcmChunk(150));
    recognizer.pushAudio(pcmChunk(150));
    recognizer.speechStarted();

    for (let index = 0; index < 6; index += 1) {
      recognizer.pushAudio(pcmChunk(100));
    }

    expect(calls).toHaveLength(0);
    await expect(recognizer.speechStopped()).resolves.toEqual(decision);
    expect(calls).toEqual([{ samples: 500, sampleRate: 1000 }]);
  });

  it("does not infer when no speech turn was opened", async () => {
    let calls = 0;
    const recognizer = new SpeakerTurnRecognizer({
      async identify() {
        calls += 1;
        return {
          kind: "unknown",
          reason: "provider_empty",
          providerId: "fake"
        };
      }
    });

    recognizer.pushAudio(pcmChunk(100));
    await expect(recognizer.speechStopped()).resolves.toBeUndefined();
    expect(calls).toBe(0);
  });
});

describe("HttpSpeakerIdentityProvider", () => {
  it("uploads one WAV plus all candidate IDs and validates returned scores", async () => {
    let requests = 0;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requests += 1;
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({ authorization: "Bearer service-token" });
      expect(init?.body).toBeInstanceOf(FormData);
      const form = init!.body as FormData;
      expect(JSON.parse(String(form.get("candidates")))).toEqual([
        { profileId: "voice:rizma" },
        { profileId: "voice:yasman" }
      ]);
      const audio = form.get("audio");
      expect(audio).toBeInstanceOf(Blob);
      expect((audio as Blob).type).toBe("audio/wav");

      return new Response(
        JSON.stringify({
          scores: [
            { profileId: "voice:rizma", score: 0.92 },
            { profileId: "voice:yasman", score: 0.55 }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }) as typeof fetch;

    const provider = new HttpSpeakerIdentityProvider(
      "http://speaker.internal/identify",
      {
        bearerToken: "service-token",
        fetchImpl
      }
    );

    await expect(
      provider.identify(
        {
          audio: {
            pcm16: new Int16Array([1, 2, 3, 4]),
            sampleRate: 16000
          },
          candidates: [
            { personId: "person:rizma", profileId: "voice:rizma" },
            { personId: "person:yasman", profileId: "voice:yasman" }
          ]
        },
        new AbortController().signal
      )
    ).resolves.toEqual({
      scores: [
        { profileId: "voice:rizma", score: 0.92 },
        { profileId: "voice:yasman", score: 0.55 }
      ]
    });
    expect(requests).toBe(1);
  });

  it("rejects a service response containing an unrequested voice profile", async () => {
    const provider = new HttpSpeakerIdentityProvider(
      "http://speaker.internal/identify",
      {
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              scores: [{ profileId: "voice:intruder", score: 0.99 }]
            }),
            { status: 200 }
          )) as typeof fetch
      }
    );

    await expect(
      provider.identify(
        {
          audio: {
            pcm16: new Int16Array([1, 2, 3, 4]),
            sampleRate: 16000
          },
          candidates: [
            { personId: "person:rizma", profileId: "voice:rizma" }
          ]
        },
        new AbortController().signal
      )
    ).rejects.toThrow(/invalid candidate/);
  });
});
