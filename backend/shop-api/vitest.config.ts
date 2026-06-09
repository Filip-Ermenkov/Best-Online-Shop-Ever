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
// Admin MFA test keys — a fixed 32-byte (AES-256) encryption key and a
// challenge HMAC key, so the /admin/auth suite exercises the real
// encrypt/decrypt + signed-challenge paths deterministically (never used
// outside tests; production sets these via SSM).
const ADMIN_MFA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
const ADMIN_MFA_CHALLENGE_KEY = "test-admin-mfa-challenge-key-fixed";
process.env.ADMIN_MFA_ENCRYPTION_KEY ??= ADMIN_MFA_ENCRYPTION_KEY;
process.env.ADMIN_MFA_CHALLENGE_KEY ??= ADMIN_MFA_CHALLENGE_KEY;
// Force the in-memory stub transport so tests never hit AWS and can assert
// on what was "sent". Per-test setup resets the recorder before each test.
process.env.EMAIL_TRANSPORT ??= "stub";
// PUBLIC_APP_BASE_URL drives the verifyUrl built into the email body.
// A stable test value lets tests assert on the URL shape if they wish.
process.env.PUBLIC_APP_BASE_URL ??= "http://localhost:3000";
// Default the HIBP screening OFF in tests so the integration suite stays
// off the public api.pwnedpasswords.com endpoint. Tests that need to
// exercise the HIBP code path flip it on locally with `process.env.X = "true"`
// + `_resetEnvForTests()` + a stubbed `globalThis.fetch`.
process.env.BREACHED_PASSWORD_CHECK_ENABLED ??= "false";

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
      BREACHED_PASSWORD_CHECK_ENABLED: "false",
      ADMIN_MFA_ENCRYPTION_KEY,
      ADMIN_MFA_CHALLENGE_KEY,
    },
  },
});
