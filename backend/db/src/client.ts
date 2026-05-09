import { drizzle as drizzleNeonHttp } from "drizzle-orm/neon-http";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { neon } from "@neondatabase/serverless";
import { Pool } from "pg";
import * as schema from "./schema/index";

/**
 * Database client factory.
 *
 * Two transports — the choice is automatic from the DATABASE_URL:
 *
 *   • Neon HTTP (production Lambda): URL hostname ends with .neon.tech.
 *     Each query is one HTTPS round-trip. No persistent TCP. Avoids the
 *     classic Lambda-vs-Postgres connection-storm problem entirely.
 *     Recommended for AWS Lambda + Neon as of 2026.
 *
 *   • node-postgres TCP pool (local dev, integration tests, future Fargate):
 *     A real connection pool against a real Postgres TCP endpoint. Mirrors
 *     production semantics for SQL behaviour while local.
 *
 * Why two? The neon-http driver uses HTTP — it cannot run interactive
 * transactions or LISTEN/NOTIFY. Local dev wants those for ergonomics
 * (drizzle-kit migrate, manual psql). So we keep node-postgres available.
 *
 * Both drivers expose the SAME drizzle interface; switching is invisible to
 * application code.
 *
 * Why the overloads on createDb
 * -----------------------------
 * `DbClient` is the *union* of the two driver return types. That union is
 * fine for code that doesn't care about driver-specific calls, but it makes
 * builder-style chains like `db.insert(...).values(...).returning({...})`
 * fail to typecheck — TS intersects the two `.returning(...)` overloads from
 * the union members and the result collapses to a no-arg signature.
 *
 * The overloads below let callers that explicitly force a driver get back
 * the *narrow* driver type, so chained methods like `.returning({...})`
 * resolve cleanly:
 *
 *   const db = createDb({ databaseUrl, driver: "node-postgres" });
 *   //    ^? NodePgDatabase<typeof schema>           ← narrow, .returning() works
 *
 *   const db2 = createDb({ databaseUrl });
 *   //    ^? DbClient                                ← union, for driver-agnostic code
 */

export type DbClient =
  | ReturnType<typeof drizzleNeonHttp<typeof schema>>
  | ReturnType<typeof drizzleNodePg<typeof schema>>;

export type NeonHttpDb = ReturnType<typeof drizzleNeonHttp<typeof schema>>;
export type NodePgDb = ReturnType<typeof drizzleNodePg<typeof schema>>;

export interface CreateDbOptions {
  databaseUrl: string;
  /**
   * Force a specific driver (overrides hostname detection). Useful in tests
   * where you want to assert driver-specific behaviour, and in scripts (like
   * `seed.ts`) that need a narrow driver type for chained builder methods.
   */
  driver?: "neon-http" | "node-postgres";
}

// Narrow returns when the driver is explicitly forced.
export function createDb(
  opts: CreateDbOptions & { driver: "node-postgres" },
): NodePgDb;
export function createDb(
  opts: CreateDbOptions & { driver: "neon-http" },
): NeonHttpDb;
// Wide return for the driver-agnostic call.
export function createDb(opts: CreateDbOptions): DbClient;

export function createDb({ databaseUrl, driver }: CreateDbOptions): DbClient {
  const useNeon =
    driver === "neon-http" ||
    (driver === undefined && /\.neon\.(tech|build)\b/i.test(databaseUrl));

  if (useNeon) {
    const sql = neon(databaseUrl);
    return drizzleNeonHttp(sql, { schema, casing: "snake_case" });
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    // Lambda-Fargate-friendly defaults; harmless on a local dev box.
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  });
  return drizzleNodePg(pool, { schema, casing: "snake_case" });
}

export { schema };
