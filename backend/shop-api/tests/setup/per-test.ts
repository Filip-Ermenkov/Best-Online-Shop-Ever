import { afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { _resetRateLimitForTests } from "../../src/lib/csp-report.js";
import { _resetExportRateLimitForTests } from "../../src/lib/data-export.js";
import { getDb } from "../../src/lib/db.js";
import {
  _resetEmailTransportForTests,
  getEmailTransport,
  getStubTransportForTests,
} from "../../src/lib/emails.js";

/**
 * Per-test isolation strategy:
 *   - Before each test, TRUNCATE all application tables (CASCADE) and reset
 *     identity counters.
 */

const TABLES_TO_TRUNCATE = [
  // Catalog
  "product_images",
  "products",
  "categories",
  "banner_slides",
  // Cart — explicit listing for documentation; TRUNCATE on users CASCADEs.
  "cart_items",
  "carts",
  // Orders — children first, parent last. TRUNCATE … CASCADE handles the
  // FKs but listing them explicitly keeps the dependency order obvious.
  "complaints",
  "order_status_history",
  "order_delivery_address",
  "order_corporate_data",
  "order_items",
  "orders",
  // Auth & users — TRUNCATE … CASCADE will pick up profile / session /
  // login_attempts / addresses rows via foreign keys. `addresses` is listed
  // explicitly (it also cascades from users) so the address-book tests start
  // from a clean book every test.
  "addresses",
  "users",
  "sessions",
  "login_attempts",
  "email_verification_tokens",
  "password_reset_tokens",
  // Consent — account-agnostic (keyed on the opaque visitor cookie, no FK to
  // users), so a TRUNCATE … CASCADE on users does NOT clear it. List it
  // explicitly or consent rows leak across tests.
  "cookie_consents",
  // Ops — written by the scheduled catalog-backup job (jobs tests). Its FK
  // to users is ON DELETE SET NULL, so be explicit rather than relying on
  // the users CASCADE to reach it.
  "catalog_backups",
  // Distributed rate-limit counters (guest find/place limiters). No FK, so it
  // is never reached by a CASCADE — clear it explicitly or a limit tripped in
  // one test bleeds into the next.
  "rate_limit_counters",
  // Settings / content
  "settings",
  "tos_versions",
  "redirects",
];

beforeEach(async () => {
  const db = getDb();
  await db.execute(
    sql.raw(
      `TRUNCATE TABLE ${TABLES_TO_TRUNCATE.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
    ),
  );
  // The `orders_order_number_seq` is a standalone sequence (not column-owned),
  // so RESTART IDENTITY above does not reset it. Tests that assert on the
  // numeric suffix of orderNumber would otherwise drift across runs and
  // become flaky. ALTER … RESTART takes a metadata-only lock and is fast.
  await db.execute(sql`ALTER SEQUENCE orders_order_number_seq RESTART WITH 1`);

  // Email transport: rebuild on first test, then reset the recorder. Without
  // resetting, recorded emails from prior tests would leak into helpers that
  // assert "exactly one mail sent for this test".
  _resetEmailTransportForTests();
  getEmailTransport(); // builds the stub from env
  getStubTransportForTests().reset();

  // CSP report endpoint maintains an in-memory per-IP token bucket. Reset
  // between tests so the rate-limit test isn't polluted by counts from
  // earlier files in the suite, and so other tests don't accidentally trip
  // the limit by chaining many requests.
  _resetRateLimitForTests();

  // POST /auth/me/export maintains an in-memory per-user frequency counter.
  // Reset it for the same reasons as the CSP bucket above.
  _resetExportRateLimitForTests();

  // The guest find/place limiters are now distributed (Postgres-backed); their
  // state lives in `rate_limit_counters`, truncated above — no in-memory reset.
});

afterAll(async () => {
  // Pool teardown is implicit via process exit.
});
