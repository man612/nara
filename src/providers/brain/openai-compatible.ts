import type { BrainProvider, BrainRequest, BrainResponse } from "../../contracts/providers.js";

export type OpenAICompatibleConfig = {
  id: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
};

export class OpenAICompatibleBrain implements BrainProvider {
  readonly id: string;

  constructor(private readonly config: OpenAICompatibleConfig) {
    this.id = config.id;
  }

  async complete(request: BrainRequest): Promise<BrainResponse> {
    const baseUrl = this.config.baseUrl.replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: request.messages,
        ...(request.tools ? { tools: request.tools } : {})
      })
    });

    if (!response.ok) throw new Error(`${this.id} failed: ${response.status} ${await response.text()}`);
    const data = (await response.json()) as any;
    const message = data.choices?.[0]?.message;
    return {
      text: message?.content ?? "",
      ...(message?.tool_calls ? { toolCalls: message.tool_calls } : {})
    };
  }
}
