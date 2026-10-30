import type { ModelImage } from "../callModel";

export type ProviderRequest = {
  system: string;
  prompt: string;
  images: ModelImage[];
  jsonSchema: Record<string, unknown>; // the answer must be JSON matching this
  signal: AbortSignal;
};

// A provider sends one request and returns the model's raw text answer.
// It throws on any API or network failure. callModel owns timeouts,
// validation and retries, so providers stay small and swappable.
export interface ModelProvider {
  readonly name: string;
  readonly model: string;
  generate(req: ProviderRequest): Promise<string>;
}
