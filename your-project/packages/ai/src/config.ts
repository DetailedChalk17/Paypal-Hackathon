import { GeminiProvider } from "./providers/gemini";
import { MockProvider } from "./providers/mock";
import type { ModelProvider } from "./providers/types";

export const DEFAULT_PROVIDER = "gemini";
export const DEFAULT_MODEL = "gemini-2.5-flash";

// Reads AI_MODE, AI_PROVIDER, AI_MODEL and AI_API_KEY from the environment.
// If AI_MODE=mock, AI_PROVIDER=mock, or no AI_API_KEY is configured,
// a deterministic MockProvider is returned so judges can test without an API key.
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): ModelProvider | null {
  const isMock =
    env.AI_MODE?.toLowerCase() === "mock" ||
    env.AI_PROVIDER?.toLowerCase() === "mock";

  if (isMock) {
    return new MockProvider();
  }

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
