import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";

/**
 * One-time test environment provisioning.
 *
 * What this does:
 *   1. Connects to the admin `postgres` database on the dev Postgres.
 *   2. Drops and recreates `shop_test`. Drop is intentional — guarantees a
 *      clean slate, so flaky tests can't leak between runs.
 *   3. Connects to `shop_test` and applies the migrations from @shop/db.
 *
 * What this does NOT do:
 *   - Seed application data. Each test is responsible for its own fixtures
 *     (see per-test.ts: every test runs in a transaction that ROLLBACKs).
 *
 * Required env: DATABASE_URL (set in vitest.config.ts) pointing at shop_test.
 *
 * Failure mode: if the dev Postgres isn't running, the test run aborts with a
 * clear error instead of hanging.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function pickDbName(url: string): { dbName: string; adminUrl: string } {
  const u = new URL(url);
  const dbName = u.pathname.replace(/^\//, "");
  if (!dbName) throw new Error(`DATABASE_URL has no database name: ${url}`);
  u.pathname = "/postgres";
  return { dbName, adminUrl: u.toString() };
}

export default async function setup() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set in test environment");

  const { dbName, adminUrl } = pickDbName(url);
  if (!dbName.endsWith("_test")) {
    throw new Error(
      `Refusing to run tests against ${dbName} — name must end with _test.`,
    );
  }

  // 1. Drop & recreate the test database via the admin connection.
  const admin = new Client({ connectionString: adminUrl });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `Could not connect to ${adminUrl}. Is the dev Postgres running? ` +
        `Try: cd backend/db && npm run db:up\nUnderlying error: ${(err as Error).message}`,
    );
  }
  // Terminate any stragglers holding a connection — otherwise DROP DATABASE
  // will fail with "database is being accessed by other users".
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [dbName],
  );
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  // 2. Apply migrations to the freshly created test DB.
  // Migrations live in @shop/db/drizzle. We resolve that path from this file's
  // location (../../../db/drizzle) — keeps the test setup decoupled from npm
  // workspace aliasing.
  const migrationsFolder = path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    "db",
    "drizzle",
  );
  const pool = new Pool({ connectionString: url, max: 1 });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder });
  await pool.end();
}
