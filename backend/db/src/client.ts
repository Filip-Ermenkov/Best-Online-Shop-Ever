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
 */

export type DbClient =
  | ReturnType<typeof drizzleNeonHttp<typeof schema>>
  | ReturnType<typeof drizzleNodePg<typeof schema>>;

export interface CreateDbOptions {
  databaseUrl: string;
  /**
   * Force a specific driver (overrides hostname detection). Useful in tests
   * where you want to assert driver-specific behaviour.
   */
  driver?: "neon-http" | "node-postgres";
}

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
