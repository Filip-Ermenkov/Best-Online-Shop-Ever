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
});

afterAll(async () => {
  // Pool teardown is implicit via process exit.
});
