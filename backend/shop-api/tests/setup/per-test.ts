import { afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { getDb } from "../../src/lib/db.js";

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
  // login_attempts rows via foreign keys.
  "users",
  "sessions",
  "login_attempts",
  "email_verification_tokens",
  "password_reset_tokens",
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
});

afterAll(async () => {
  // Pool teardown is implicit via process exit.
});
