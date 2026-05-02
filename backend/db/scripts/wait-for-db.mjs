/**
 * Cross-platform wait-for-Postgres. Polls TCP + auth until success or timeout.
 *
 * Why this script exists:
 *   `db:reset` previously used `sleep 3` between `docker compose up` and the
 *   first migration. That fails on Windows (no `sleep` in cmd.exe) and is
 *   also a guess — Postgres may need more than 3 seconds on a cold start, or
 *   less. This script polls properly with a timeout, on every platform.
 *
 * Reads DATABASE_URL from the workspace .env (loaded via dotenv). Falls back
 * to the docker-compose default credentials if .env isn't present yet.
 *
 * Exits 0 on success, 1 on timeout. Logs each retry to stderr so CI logs
 * make the wait visible.
 */

import "dotenv/config";
import { Client } from "pg";

const url =
  process.env.DATABASE_URL ??
  "postgres://shop:shop@localhost:5432/shop";

const TIMEOUT_MS = Number.parseInt(process.env.DB_WAIT_TIMEOUT_MS ?? "30000", 10);
const RETRY_MS = 500;

const start = Date.now();
let attempt = 0;

while (Date.now() - start < TIMEOUT_MS) {
  attempt++;
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    await client.query("SELECT 1");
    await client.end();
    const elapsed = Date.now() - start;
    console.error(`Postgres ready after ${attempt} attempt(s), ${elapsed}ms.`);
    process.exit(0);
  } catch (err) {
    // Quietly retry — most early failures are "connection refused" or
    // "the database system is starting up".
    try {
      await client.end();
    } catch {
      /* ignore */
    }
    if (attempt === 1 || attempt % 4 === 0) {
      console.error(
        `[wait-for-db] attempt ${attempt}: ${(err && err.code) || "?"} — retrying in ${RETRY_MS}ms`,
      );
    }
    await new Promise((r) => setTimeout(r, RETRY_MS));
  }
}

console.error(
  `[wait-for-db] timed out after ${TIMEOUT_MS}ms — Postgres did not become ready.`,
);
process.exit(1);
