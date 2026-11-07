import { vi } from "vitest";
import type { ModelProvider, ProviderRequest } from "../src/providers/types";

// A fake provider that replays scripted answers; no network.
// An answer can be a string, an Error to throw, "hang" to never resolve,
// or a function that builds the answer from the request.
export type ScriptedAnswer = string | Error | "hang" | ((req: ProviderRequest) => string);

export function fakeProvider(...answers: ScriptedAnswer[]) {
  const requests: ProviderRequest[] = [];
  const provider: ModelProvider = {
    name: "fake",
    model: "fake-1",
    generate: vi.fn(async (req: ProviderRequest) => {
      requests.push(req);
      const next = answers.shift();
      if (next === "hang") return new Promise<string>(() => {});
      if (next instanceof Error) throw next;
      if (typeof next === "function") return next(req);
      if (next === undefined) throw new Error("no scripted answer");
      return next;
    }),
  };
  return { provider, requests };
}
