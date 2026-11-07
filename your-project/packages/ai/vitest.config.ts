import { defineConfig } from "vitest/config";

// Unit tests only: live tests call the real model and run via `npm run test:live`.
export default defineConfig({
  test: { exclude: ["**/node_modules/**", "test/live/**"] },
});
