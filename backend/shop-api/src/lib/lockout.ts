import { schema } from "@shop/db";
import { and, count, eq, gte } from "drizzle-orm";
import { getDb } from "./db.js";

/**
 * Brute-force lockout, per spec README §8:
 *
 *   "При 5 последователни неуспешни опита за вход акаунтът се блокира
 *    временно за 15 минути."
 *
 * Implementation:
 *   1. Every login attempt — success or fail — appends a row to login_attempts.
 *   2. Before authenticating, count failed attempts in the trailing 15-minute
 *      window for that email. If ≥ 5 → return locked.
 *   3. After a successful login we don't actively reset the counter; the
 *      sliding window naturally clears in 15 minutes. (Re-locking shortly
 *      after success is fine — five real fails again would still need to
 *      happen.)
 *
 * Why per-email and not per-user-id:
 *   - Probes against non-existent emails get logged too (typos, dictionary
 *     attacks). The same email gets the lockout regardless of whether a
 *     user exists. This blunts user-enumeration via timing AND via response
 *     codes.
 *   - It also means a single attacker trying a single victim's email can't
 *     escape the lockout by varying their IP. The cost is that an attacker
 *     can lock a known victim's account remotely — accepted in the spec, and
 *     the victim has the password-reset escape hatch.
 *
 * IP-based rate limiting (per the README's "защита") is intentionally NOT
 * here — it belongs at the WAF layer (CloudFront/WAF) where we can drop
 * abusive IPs before they hit Lambda. A noisy DB write per failed attempt
 * is not the right defence-in-depth for IP-volume attacks.
 */

const WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_THRESHOLD = 5;

export interface LockoutState {
  locked: boolean;
  /** When the lock lifts. null when not locked. */
  unlockAt: Date | null;
  /** Failed attempts inside the current window. */
  recentFailures: number;
}

/**
 * Inspect the lockout state for a given email. Always read-only.
 *
 * Implementation note: we look at login_attempts directly rather than
 * trusting users.locked_until (which exists in the schema for future use
 * by the admin moderation flow) — login_attempts is the audit-log truth
 * and not subject to admin override.
 */
export async function getLockoutState(email: string): Promise<LockoutState> {
  const db = getDb();
  const since = new Date(Date.now() - WINDOW_MS);

  const [row] = await db
    .select({ failures: count() })
    .from(schema.loginAttempts)
    .where(
      and(
        eq(schema.loginAttempts.email, email),
        eq(schema.loginAttempts.success, false),
        gte(schema.loginAttempts.attemptedAt, since),
      ),
    );

  const recentFailures = Number(row?.failures ?? 0);
  if (recentFailures < LOCKOUT_THRESHOLD) {
    return { locked: false, unlockAt: null, recentFailures };
  }

  // Locked — find the oldest failure inside the window. Window slides off
  // its position + 15 min, which is when the count drops back below 5.
  const [oldest] = await db
    .select({ attemptedAt: schema.loginAttempts.attemptedAt })
    .from(schema.loginAttempts)
    .where(
      and(
        eq(schema.loginAttempts.email, email),
        eq(schema.loginAttempts.success, false),
        gte(schema.loginAttempts.attemptedAt, since),
      ),
    )
    .orderBy(schema.loginAttempts.attemptedAt)
    .limit(1);

  const unlockAt = oldest
    ? new Date(oldest.attemptedAt.getTime() + WINDOW_MS)
    : new Date(Date.now() + WINDOW_MS);

  return { locked: true, unlockAt, recentFailures };
}

export interface RecordAttemptInput {
  email: string;
  success: boolean;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function recordAttempt(input: RecordAttemptInput): Promise<void> {
  const db = getDb();
  await db.insert(schema.loginAttempts).values({
    email: input.email,
    success: input.success,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  });
}

/**
 * 180-day retention is documented on the login_attempts schema. The cleanup
 * job that enforces it is a separate slice (scheduled task) — when it lands
 * it will live next to this file so the retention contract has a single
 * home.
 */
