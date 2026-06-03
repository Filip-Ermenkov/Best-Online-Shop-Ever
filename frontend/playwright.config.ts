import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the accessibility (axe-core) runtime audit.
 *
 * This is the RUNTIME layer of the WCAG 2.2 AA / EAA continuous audit
 * (COMPLIANCE.md §13). It catches what the static `eslint-plugin-jsx-a11y`
 * layer cannot: computed colour contrast, focus order, ARIA wired up at
 * runtime, and reflow. Run it with `npm run test:a11y`.
 *
 * Like `next build`, this is intentionally a local / pre-push gate rather than
 * a hard CI job: a faithful run wants the shop-api + a seeded Postgres beside
 * the Next dev server (same constraint that keeps `next build` out of CI —
 * see README "Continuous integration"). The pages scanned in
 * `tests/a11y/axe.spec.ts` are chosen to degrade gracefully so the audit still
 * produces signal when the API is down, but a full pass should run against the
 * live stack. Once a build-time API stub exists, promote this to CI.
 */
export default defineConfig({
  testDir: "./tests/a11y",
  // Accessibility checks are deterministic; no retries needed.
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.A11Y_BASE_URL ?? "http://localhost:3000",
    // Deterministic viewport so reflow / target-size checks are reproducible.
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  // Boot the Next dev server for the audit unless one is already running
  // (or A11Y_BASE_URL points at an external deployment).
  webServer: process.env.A11Y_BASE_URL
    ? undefined
    : {
        command: "npm run dev",
        url: "http://localhost:3000",
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
