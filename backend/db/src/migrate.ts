/**
 * Apply all pending migrations to the target database.
 *
 * Used in three places:
 *   1. Local dev:    `npm run db:migrate` after `npm run db:up`
 *   2. CI:           on every PR, against an ephemeral Postgres
 *   3. Production:   in a separate Lambda that runs migrations BEFORE the
 *                    application deploy lands. (The application deploy must
 *                    NEVER apply migrations on cold start — that's a recipe
 *                    for race conditions and dependency cycles.)
 *
 * The script intentionally uses node-postgres rather than the Neon HTTP
 * driver: drizzle-kit migrations need a connection that supports advisory
 * locks (`SELECT pg_advisory_lock(...)`) so that two concurrent migrators
 * cannot run the same migration twice. Neon's pooled TCP endpoint supports
 * this; the HTTP endpoint does not.
 */

import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "..", "drizzle");

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(
      "DATABASE_URL is not set. Copy .env.example to .env or export it.",
    );
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const db = drizzle(pool);

  console.log(`Applying migrations from ${migrationsFolder} ...`);
  const start = Date.now();
  await migrate(db, { migrationsFolder });
  console.log(`Migrations applied in ${Date.now() - start}ms.`);

  await pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
