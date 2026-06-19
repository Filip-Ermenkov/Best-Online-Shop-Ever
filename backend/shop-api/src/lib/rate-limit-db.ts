/**
 * Distributed, Postgres-backed fixed-window rate limiter.
 *
 * Why this exists
 * ---------------
 * The public guest surface (`routes/guest.ts`) caps abuse per IP — lost-link
 * resend at 3/hour (spec §7) and anonymous order placement at 30/hour. The
 * first implementation kept those counters in a per-process `Map`. On Lambda
 * that is per-CONTAINER state: with N warm containers the effective ceiling is
 * N × limit, and every cold start wipes the window. So the hard guarantee the
 * docs assert ("максимум 3 заявки на час от един IP адрес") silently did not
 * hold in the target serverless deployment.
 *
 * This limiter keeps the counter where every container already shares state —
 * Postgres — so the limit holds cluster-wide. It is the same stance the rest of
 * the codebase already takes for distributed counting: the login lockout reads
 * `login_attempts`, forgot-password/resend count token rows, the scheduler jobs
 * claim work with marker columns. No new infrastructure, no DynamoDB, no Redis
 * (see `docs/ARCHITECTURE.md` §13).
 *
 * Correctness (no lost increments, no advisory lock)
 * --------------------------------------------------
 * One statement does the whole check-and-count:
 *
 *   INSERT INTO rate_limit_counters (bucket, subject, window_start, count)
 *   VALUES (…, 1)
 *   ON CONFLICT (bucket, subject, window_start)
 *   DO UPDATE SET count = rate_limit_counters.count + 1
 *     WHERE rate_limit_counters.count < <limit>
 *   RETURNING count;
 *
 * Postgres locks the conflicting row and re-reads its latest committed version
 * before applying the UPDATE, so concurrent writers serialise on the row lock
 * with no lost updates — no `pg_advisory_xact_lock`, no separate SELECT (the
 * pattern the Neon how-to needs only because it reads the count in a second
 * statement). The `WHERE count < limit` guard means an already-blocked caller
 * is NOT incremented (so a sustained flood cannot grow the row unboundedly, and
 * a blocked hit costs no extra write): when the guard fails the statement
 * touches nothing and `RETURNING` yields zero rows — that empty result *is* the
 * "blocked" signal.
 *
 * Window model
 * ------------
 * Fixed (tumbling) windows aligned to the epoch: `window_start =
 * floor(now / windowMs) * windowMs`, computed app-side (so the clock is
 * injectable in tests) and stored as part of the primary key. A new window is
 * therefore just a new row that starts again at 1 — no reset/CASE logic. The
 * documented trade-off is fixed-window boundary amplification (up to ~2× across
 * the instant a window rolls); that is acceptable for an abuse dampener (it is
 * the same semantics the in-memory limiter had) and never weakens enumeration
 * resistance, which comes from the uniform response, not this counter.
 *
 * Failure bias: fail-OPEN. A limiter hiccup must not take down a public
 * endpoint, and this counter is a dampener, not a security boundary — the
 * 256-bit tracking token is. Aged-out rows are pruned by the daily retention
 * sweep (`jobs/unverified-cleanup.ts`).
 */

import { type DbClient } from "@shop/db";
import { sql } from "drizzle-orm";
import type { Logger } from "pino";
import { getDb } from "./db.js";

export interface DbRateLimitResult {
  /** True when the hit is within budget (and has been counted). */
  allowed: boolean;
  /** Hits remaining in the current window after this call (never negative). */
  remaining: number;
  /** Epoch ms when the current window resets. */
  resetAt: number;
}

export interface DbRateLimiterOptions {
  /** Limiter namespace — the `bucket` column, e.g. "guest_find". */
  bucket: string;
  /** Max allowed hits per `subject` within one window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** DB resolver. Defaults to the shared `getDb()`. Injectable for tests. */
  db?: () => DbClient;
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Optional logger; a fail-open DB error is logged here at WARN. */
  logger?: Logger;
}

export interface DbRateLimiter {
  /**
   * Count a hit for `subject`; resolves to whether it is within budget. Never
   * rejects — a DB error fails open (allowed) and is logged.
   */
  hit(subject: string): Promise<DbRateLimitResult>;
}

/** Driver-portable first-row pick for raw `db.execute()` (see lib/withdrawal.ts). */
function pickFirstRow<T>(result: unknown): T | null {
  if (Array.isArray(result)) return (result[0] as T | undefined) ?? null;
  const r = result as { rows?: unknown[] } | null | undefined;
  if (r && Array.isArray(r.rows)) return (r.rows[0] as T | undefined) ?? null;
  return null;
}

export function createDbRateLimiter(opts: DbRateLimiterOptions): DbRateLimiter {
  const bucket = opts.bucket;
  const limit = Math.max(1, Math.floor(opts.limit));
  const windowMs = Math.max(1, Math.floor(opts.windowMs));
  const resolveDb = opts.db ?? getDb;
  const now = opts.now ?? Date.now;

  return {
    async hit(subject: string): Promise<DbRateLimitResult> {
      const nowMs = now();
      const windowStartMs = Math.floor(nowMs / windowMs) * windowMs;
      const resetAt = windowStartMs + windowMs;
      const windowStartIso = new Date(windowStartMs).toISOString();

      try {
        const result = await resolveDb().execute(sql`
          INSERT INTO rate_limit_counters (bucket, subject, window_start, count)
          VALUES (${bucket}, ${subject}, ${windowStartIso}::timestamptz, 1)
          ON CONFLICT (bucket, subject, window_start)
          DO UPDATE SET count = rate_limit_counters.count + 1
            WHERE rate_limit_counters.count < ${limit}
          RETURNING count
        `);

        const row = pickFirstRow<{ count: number | string }>(result);
        if (!row) {
          // WHERE guard failed → already at/over the limit this window, and the
          // row was deliberately NOT incremented. This is the blocked signal.
          return { allowed: false, remaining: 0, resetAt };
        }

        const count = Number(row.count);
        return { allowed: true, remaining: Math.max(0, limit - count), resetAt };
      } catch (err) {
        // Fail open: never let a limiter fault break the public endpoint.
        opts.logger?.warn(
          { err, bucket },
          "rate_limit_db_unavailable_failing_open",
        );
        return { allowed: true, remaining: limit - 1, resetAt };
      }
    },
  };
}
