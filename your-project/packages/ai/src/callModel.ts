import type { z } from "zod";
import type { AiResult } from "@your-project/shared";

export type ModelImage = {
  mediaType: "image/jpeg" | "image/png";
  data: Uint8Array;
};

export type CallModelArgs<T> = {
  schema: z.ZodType<T>;
  system: string;
  prompt: string;
  images?: ModelImage[];
};

export const MODEL_TIMEOUT_MS = 20_000;

// STUB (step 0). Step A1 replaces this with the provider adapter: 20s timeout,
// Zod validation, and one retry on invalid output. Until then it reports an API
// error, so nothing can depend on real model output by accident.
export async function callModel<T>(_args: CallModelArgs<T>): Promise<AiResult<T>> {
  return { ok: false, reason: "api_error" };
}
