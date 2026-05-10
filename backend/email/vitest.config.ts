import { defineConfig } from "vitest/config";

/**
 * Pure-function unit tests for templates + a mock-driven transport test.
 * No real network — the SES transport is exercised against a stubbed
 * SESv2Client.send so we get end-to-end command shape coverage without
 * requiring AWS creds.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 10_000,
  },
});
