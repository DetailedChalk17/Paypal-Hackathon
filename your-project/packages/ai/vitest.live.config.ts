import { defineConfig } from "vitest/config";

// Live tests call the real model with AI_API_KEY from your-project/.env.
export default defineConfig({
  test: { include: ["test/live/**/*.test.ts"], testTimeout: 120_000 },
});
