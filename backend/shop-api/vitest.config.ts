import { defineConfig } from "vitest/config";

/**
 * Integration tests run against a real Postgres (the docker-compose one in
 * @shop/db), but pointed at a separate database name `shop_test`.
 *
 *   - globalSetup runs ONCE per test run, in the parent Node process. It
 *     drops + recreates `shop_test` and applies migrations.
 *   - per-test setup runs per test file in its worker. Each `beforeEach`
 *     TRUNCATEs all application tables — full isolation.
 *
 * Important Vitest 4 quirk
 * ------------------------
 * `test.env` only injects vars into the test WORKER processes. The parent
 * process — which runs `globalSetup` — does NOT see them. So we set the
 * defaults at module top, before defineConfig runs. They flow through to
 * both the parent and the workers.
 *
 * Override on the command line if needed:
 *   $env:DATABASE_URL="..."; npm test
 */
process.env.DATABASE_URL ??=
  "postgresql://shop:shop@localhost:5432/shop_test";
process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "silent";
// Force the in-memory stub transport so tests never hit AWS and can assert
// on what was "sent". Per-test setup resets the recorder before each test.
process.env.EMAIL_TRANSPORT ??= "stub";
// PUBLIC_APP_BASE_URL drives the verifyUrl built into the email body.
// A stable test value lets tests assert on the URL shape if they wish.
process.env.PUBLIC_APP_BASE_URL ??= "http://localhost:3000";

export default defineConfig({
  test: {
    globalSetup: ["./tests/setup/global-setup.ts"],
    setupFiles: ["./tests/setup/per-test.ts"],
    include: ["tests/**/*.test.ts"],
    // Single-fork keeps everything deterministic for now. The TRUNCATE-per-
    // test strategy assumes one worker; running in parallel would race on the
    // shared shop_test DB. Once the suite is large enough for parallelism to
    // pay off, switch to one DB schema per worker.
    pool: "forks",
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Worker-side env, mirrored from the parent above. Must match — the test
    // worker spawns a child process and re-reads env from scratch.
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ??
        "postgresql://shop:shop@localhost:5432/shop_test",
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      EMAIL_TRANSPORT: "stub",
      PUBLIC_APP_BASE_URL: "http://localhost:3000",
    },
  },
});
