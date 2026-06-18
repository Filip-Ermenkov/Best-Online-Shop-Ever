import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { Pool as NeonPool, neonConfig } from "@neondatabase/serverless";
import { Pool as PgPool } from "pg";
import * as schema from "./schema/index";

/**
 * Database client factory.
 *
 * Two transports — the choice is automatic from the DATABASE_URL:
 *
 *   • Neon serverless driver (production Lambda): URL hostname ends with
 *     .neon.tech / .neon.build. This single client uses TWO wire transports
 *     under the hood (see the neonConfig block below):
 *       - ordinary queries  → one stateless HTTPS `fetch` round-trip
 *         (`poolQueryViaFetch`). No persistent TCP, no connection storm —
 *         the property the old HTTP-only driver gave us, preserved for the
 *         >99% query path.
 *       - interactive transactions → a WebSocket opened for the duration of
 *         the transaction only, then released. This is what `db.transaction()`
 *         needs and what the HTTP-only driver could NOT do (it throws
 *         "No transactions support in neon-http driver"). The app relies on
 *         transactions in checkout, registration, password reset, email
 *         change/verification, account deletion, admin order transitions and
 *         the scheduler jobs — so the runtime driver MUST support them.
 *
 *   • node-postgres TCP pool (local dev, integration tests, future Fargate):
 *     A real connection pool against a real Postgres TCP endpoint. Mirrors
 *     production SQL semantics while local, and (unlike either Neon transport)
 *     supports advisory locks / LISTEN-NOTIFY for tooling.
 *
 * Both drivers expose the SAME drizzle interface AND both support
 * `db.transaction(...)`, so switching is invisible to application code.
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
 *   //    ^? NodePgDb                                ← narrow, .returning() works
 *
 *   const db2 = createDb({ databaseUrl });
 *   //    ^? DbClient                                ← union, for driver-agnostic code
 */

// --- Neon serverless driver: global configuration (set once at load) -------
//
// `poolQueryViaFetch` routes plain `Pool.query()` calls over a low-latency
// HTTPS fetch instead of the WebSocket — but ONLY when the Pool has no
// "connect"/"acquire"/"release"/"remove" listeners (an "error" listener is
// explicitly exempt in the driver). So we attach ONLY an "error" listener
// below, and ordinary queries stay stateless while transactions (which call
// pool.connect()) transparently use a WebSocket.
neonConfig.poolQueryViaFetch = true;

// The WebSocket transaction path needs a WebSocket constructor. Node 21+ (our
// Lambda runtime is nodejs22.x) exposes a global `WebSocket`, so we point the
// driver at it and need NO `ws` dependency in the bundle. Guarded so this is a
// harmless no-op on a runtime that already wired its own constructor.
const webSocketCtor = (globalThis as { WebSocket?: unknown }).WebSocket;
if (typeof webSocketCtor === "function" && !neonConfig.webSocketConstructor) {
  // Cast via `unknown`: as of @neondatabase/serverless 1.x,
  // `neonConfig.webSocketConstructor` is a typed accessor
  // (`WebSocketConstructor | undefined`), so a direct `Function`→that-type
  // cast no longer overlaps (TS2352). The runtime `typeof … === "function"`
  // guard above makes the assignment sound.
  neonConfig.webSocketConstructor =
    webSocketCtor as unknown as typeof neonConfig.webSocketConstructor;
}

/**
 * Drop `channel_binding=require` from a Neon connection string for the
 * WebSocket transport.
 *
 * The serverless driver runs the Postgres wire protocol inside a secure `wss:`
 * tunnel (TLS terminated by Neon), so the SCRAM handshake has no Postgres-level
 * TLS channel to bind to. With `channel_binding=require` the handshake fails
 * with a SASL channel-binding error. Confidentiality is provided by the wss
 * tunnel, so dropping the pg-level requirement is the correct serverless
 * posture (the fetch query path ignores the parameter regardless). Keeping
 * `sslmode=require` and everything else intact.
 */
function neonConnectionString(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    url.searchParams.delete("channel_binding");
    return url.toString();
  } catch {
    // Not a parseable URL (shouldn't happen for a real DATABASE_URL) — pass it
    // through unchanged rather than crash the factory at import time.
    return databaseUrl;
  }
}

export type DbClient =
  | ReturnType<typeof drizzleNeon<typeof schema>>
  | ReturnType<typeof drizzleNodePg<typeof schema>>;

export type NeonDb = ReturnType<typeof drizzleNeon<typeof schema>>;
export type NodePgDb = ReturnType<typeof drizzleNodePg<typeof schema>>;

export interface CreateDbOptions {
  databaseUrl: string;
  /**
   * Force a specific driver (overrides hostname detection). Useful in tests
   * where you want to assert driver-specific behaviour, and in scripts (like
   * `seed.ts`) that need a narrow driver type for chained builder methods.
   */
  driver?: "neon" | "node-postgres";
}

// Narrow returns when the driver is explicitly forced.
export function createDb(
  opts: CreateDbOptions & { driver: "node-postgres" },
): NodePgDb;
export function createDb(opts: CreateDbOptions & { driver: "neon" }): NeonDb;
// Wide return for the driver-agnostic call.
export function createDb(opts: CreateDbOptions): DbClient;

export function createDb({ databaseUrl, driver }: CreateDbOptions): DbClient {
  const useNeon =
    driver === "neon" ||
    (driver === undefined && /\.neon\.(tech|build)\b/i.test(databaseUrl));

  if (useNeon) {
    const pool = new NeonPool({
      connectionString: neonConnectionString(databaseUrl),
      // Only the transaction path uses these connections (ordinary queries go
      // over fetch). One WebSocket at a time matches Lambda's
      // one-request-per-container execution model; idle sockets are reaped so
      // a frozen container is unlikely to wake holding a dead one.
      max: 1,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
    // A transaction's WebSocket can be dropped by the Neon proxy (e.g. while a
    // Lambda container is frozen between invocations). Swallow the async
    // "error" so a dead idle socket cannot crash the process — the next
    // transaction opens a fresh connection. NB: an "error" listener is the one
    // listener that does NOT disable `poolQueryViaFetch`.
    pool.on("error", (err: Error) => {
      console.error("[db] neon pool socket error:", err.message);
    });
    return drizzleNeon(pool, { schema, casing: "snake_case" });
  }

  const pool = new PgPool({
    connectionString: databaseUrl,
    // Lambda-Fargate-friendly defaults; harmless on a local dev box.
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  });
  return drizzleNodePg(pool, { schema, casing: "snake_case" });
}

export { schema };
