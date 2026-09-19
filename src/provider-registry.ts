import { OpenAICompatibleBrain } from "./providers/brain/openai-compatible.js";

export type BrainConfig = {
  adapter: "openai-compatible";
  id: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
};

export function createBrain(config: BrainConfig) {
  switch (config.adapter) {
    case "openai-compatible":
      return new OpenAICompatibleBrain(config);
  }
}
