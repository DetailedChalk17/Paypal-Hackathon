import type { z } from "zod";
import type { AiResult } from "@your-project/shared";

// Every value leaving this package goes through its Zod schema.
export function validated<T>(schema: z.ZodType<T>, data: unknown): AiResult<T> {
  const parsed = schema.safeParse(data);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, reason: "invalid_output" };
}
