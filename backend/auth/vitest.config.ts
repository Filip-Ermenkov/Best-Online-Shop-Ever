import { defineConfig } from "vitest/config";

/**
 * Pure-function unit tests. No DB, no network. The default Vitest config
 * is enough — keeping a file here so `npm --workspace @shop/auth run test`
 * works without explicit flags and so a future setupFiles entry has a
 * natural home.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
