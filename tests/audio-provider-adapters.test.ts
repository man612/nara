import { describe, expect, it } from "vitest";
import { OpenAICompatibleStt } from "../src/providers/stt/openai-compatible.js";
import { OpenAICompatibleTts } from "../src/providers/tts/openai-compatible.js";

describe("OpenAI-compatible speech adapters", () => {
  it("wraps Nara PCM input as WAV multipart for transcription", async () => {
    const stt = new OpenAICompatibleStt({
      id: "stt",
      baseUrl: "https://speech.invalid/v1/",
      model: "transcribe-model",
      apiKey: "secret",
      language: "id",
      fetchImpl: async (input, init) => {
        expect(String(input)).toBe(
          "https://speech.invalid/v1/audio/transcriptions"
        );
        expect(init?.method).toBe("POST");
        expect(init?.headers).toEqual({
          authorization: "Bearer secret"
        });
        expect(init?.body).toBeInstanceOf(FormData);

        const form = init!.body as FormData;
        expect(form.get("model")).toBe("transcribe-model");
        expect(form.get("response_format")).toBe("json");
        expect(form.get("language")).toBe("id");
        const file = form.get("file");
        expect(file).toBeInstanceOf(Blob);
        const bytes = new Uint8Array(
          await (file as Blob).arrayBuffer()
        );
        expect(Buffer.from(bytes.subarray(0, 4)).toString("ascii")).toBe(
          "RIFF"
        );
        expect(Buffer.from(bytes.subarray(8, 12)).toString("ascii")).toBe(
          "WAVE"
        );

        return Response.json({ text: " halo dunia " });
      }
    });

    await expect(
      stt.transcribe({
        format: "pcm16le",
        data: Uint8Array.from([1, 0, 2, 0]),
        sampleRate: 16_000,
        channels: 1
      })
    ).resolves.toBe("halo dunia");
  });

  it("requests raw PCM speech and exposes its configured sample rate", async () => {
    const tts = new OpenAICompatibleTts({
      id: "tts",
      baseUrl: "https://speech.invalid/v1",
      model: "tts-model",
      voice: "coral",
      sampleRate: 24_000,
      fetchImpl: async (input, init) => {
        expect(String(input)).toBe(
          "https://speech.invalid/v1/audio/speech"
        );
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          model: "tts-model",
          voice: "coral",
          input: "Halo.",
          response_format: "pcm"
        });
        return new Response(Uint8Array.from([1, 0, 2, 0]));
      }
    });

    await expect(tts.synthesize(" Halo. ")).resolves.toEqual({
      format: "pcm16le",
      data: Uint8Array.from([1, 0, 2, 0]),
      sampleRate: 24_000,
      channels: 1
    });
  });
});
