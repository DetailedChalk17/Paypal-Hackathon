import { GeminiProvider } from "./providers/gemini";
import type { ModelProvider } from "./providers/types";

export const DEFAULT_PROVIDER = "gemini";
export const DEFAULT_MODEL = "gemini-3.8-flash";

// Reads AI_PROVIDER, AI_MODEL and AI_API_KEY from the environment. The caller
// (API server or eval script) is responsible for loading .env.
// Returns null when no key is set, which callModel reports as api_error.
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): ModelProvider | null {
  const apiKey = env.AI_API_KEY?.trim();
  if (!apiKey) return null;

  const provider = env.AI_PROVIDER?.trim() || DEFAULT_PROVIDER;
  const model = env.AI_MODEL?.trim() || DEFAULT_MODEL;
  switch (provider) {
    case "gemini":
      return new GeminiProvider(model, apiKey);
    default:
      return null;
  }
}
