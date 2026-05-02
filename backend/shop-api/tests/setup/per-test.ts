import { afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { getDb } from "../../src/lib/db.js";

/**
 * Per-test isolation strategy:
 *   - Before each test, TRUNCATE all application tables (CASCADE) and reset
 *     identity counters. This is fast on a tiny dev DB (single-digit ms) and
 *     gives the strongest isolation guarantee — tests cannot leak through
 *     each other no matter what.
 *
 * We deliberately do NOT use BEGIN/ROLLBACK per test:
 *   - it requires routing every query through the same client (hard to wire
 *     through the API code which uses a pool / HTTP driver),
 *   - if a test triggers a SAVEPOINT or its own transaction inside, the outer
 *     ROLLBACK can leave the DB in a confused state.
 *
 * Both routes are well-known patterns; the decision here is "TRUNCATE is
 * simpler and correct" for the slice we're at.
 */

const TABLES_TO_TRUNCATE = [
  // Catalog
  "product_images",
  "products",
  "categories",
  "banner_slides",
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
  // Single TRUNCATE … CASCADE wipes everything reachable. Restart identity is
  // belt-and-braces — none of our tables actually use SERIAL, but if one
  // gets added later this still does the right thing.
  await db.execute(
    sql.raw(
      `TRUNCATE TABLE ${TABLES_TO_TRUNCATE.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`,
    ),
  );
});

afterAll(async () => {
  // Vitest has no afterAll-the-suite hook for the pg.Pool; the process exits
  // cleanly after tests, so leaking the pool is harmless. We still attempt a
  // soft close in case the pool exposes one.
  // (createDb returns a Drizzle wrapper without a close() — pool teardown
  // is implicit via process exit.)
});
