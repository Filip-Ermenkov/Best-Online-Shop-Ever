import { createDb, type DbClient } from "@shop/db";
import { parseEnv } from "./env.js";

/**
 * Reuse a single DB client per process / per Lambda warm container.
 *
 * The Drizzle factory in @shop/db automatically picks the right driver:
 *   - hostname matches /\.neon\.(tech|build)/  →  Neon HTTP (production)
 *   - everything else                            →  node-postgres TCP pool
 *
 * For the HTTP driver this just memoises the `neon(url)` callable, which is
 * essentially free. For the TCP driver this is genuinely important — we want
 * the pg.Pool to outlive the request, not be torn down between routes.
 *
 * We deliberately do NOT close the pool in the request lifecycle. On Lambda
 * the container freeze handles it. Locally, the dev server runs forever.
 */
let cached: DbClient | null = null;

export function getDb(): DbClient {
  if (cached) return cached;
  const env = parseEnv();
  cached = createDb({ databaseUrl: env.DATABASE_URL });
  return cached;
}

/** Test-only. */
export function _setDbForTests(db: DbClient | null): void {
  cached = db;
}
