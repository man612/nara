import { describe, expect, it } from "vitest";
import { OpenAICompatibleBrain } from "../src/providers/brain/openai-compatible.js";

describe("OpenAI-compatible brain tool turns", () => {
  it("serializes tool history and normalizes returned function calls", async () => {
    const brain = new OpenAICompatibleBrain({
      id: "brain",
      baseUrl: "https://brain.invalid/v1",
      model: "brain-model",
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.messages).toEqual([
          { role: "user", content: "cek" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "device_status",
                  arguments: "{}"
                }
              }
            ]
          },
          {
            role: "tool",
            content: "{\"ok\":true}",
            tool_call_id: "call-1"
          }
        ]);

        return Response.json({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call-2",
                    type: "function",
                    function: {
                      name: "web_search",
                      arguments: "{\"query\":\"hari ini\"}"
                    }
                  }
                ]
              }
            }
          ]
        });
      }
    });

    await expect(
      brain.complete({
        messages: [
          { role: "user", content: "cek" },
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "call-1",
                name: "device_status",
                arguments: {}
              }
            ]
          },
          {
            role: "tool",
            name: "device_status",
            toolCallId: "call-1",
            content: "{\"ok\":true}"
          }
        ]
      })
    ).resolves.toMatchObject({
      text: "",
      toolCalls: [
        {
          id: "call-2",
          name: "web_search",
          arguments: { query: "hari ini" }
        }
      ]
    });
  });
});
