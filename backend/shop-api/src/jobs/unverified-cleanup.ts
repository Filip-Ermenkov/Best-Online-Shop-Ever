import { schema } from "@shop/db";
import { and, eq, gt, isNull, lt, lte, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { getDb } from "../lib/db.js";
import { issueSignupVerificationToken } from "../lib/email-verification.js";
import { sendAccountDeletionWarningEmail } from "../lib/job-emails.js";

/**
 * Daily unverified-account cleanup (docs/README.md §8 „Автоматично изтриване
 * на неверифицирани акаунти") — the GDPR Art. 5(1)(e) storage-limitation
 * sweep:
 *
 *   - Day 6: one warning email — „Вашият акаунт ще бъде изтрит утре…" with a
 *     FRESH 24h verification token (the registration token has expired).
 *   - Day 7: the account is hard-DELETED.
 *   - Plus the login_attempts retention prune: rows older than 180 days go,
 *     honouring the retention the schema has promised since day one
 *     ("cleaned by a scheduled task"). 180 days keeps a meaningful
 *     brute-force/forensics horizon (the lockout itself only reads a
 *     15-minute window) while bounding how long IP/user-agent rows live.
 *
 * Why hard delete, not executeAccountDeletion()? That routine keeps a
 * pseudonymised users row because deleted customers can own orders that are
 * legally retained. An unverified customer CANNOT have placed an order
 * (ordering is verification-gated), so nothing is legally retained and the
 * row itself can go — the strictest, most storage-limitation-true outcome.
 * Every dependent table (sessions, tokens, carts, profiles, addresses,
 * login_attempts, tos acceptances) cascades at the FK level, and a
 * NOT EXISTS(orders) guard makes the no-orders invariant load-bearing
 * rather than assumed.
 *
 * Safety rails:
 *   - role = 'customer' everywhere — the bootstrap admin (created by
 *     scripts/create-admin.ts without a verified email) is structurally
 *     outside both phases, and the partial index encodes the same predicate.
 *   - The warning phase claims via unverified_deletion_warning_at in the
 *     same UPDATE that selects (claim-then-send): at-least-once scheduling
 *     can never double-warn. A refused send is compensated so the next run
 *     retries.
 *   - Deletion is spec-literal: ≥7 days unverified ⇒ delete, whether or not
 *     the courtesy warning succeeded. Retention wins over courtesy — the
 *     alternative (block deletion on a perpetually bouncing address) is an
 *     unbounded-retention bug in the other direction.
 *   - The warn phase EXCLUDES rows already ≥7 days old: after scheduler
 *     downtime an overdue account is deleted by this same run, and
 *     "warn + delete seconds later" would be worse than no email at all.
 */

export const UNVERIFIED_RETENTION_DAYS = 7;
export const UNVERIFIED_WARNING_DAYS = 6;
/** Schema-promised audit-log retention (backend/db schema/auth.ts). */
export const LOGIN_ATTEMPTS_RETENTION_DAYS = 180;
/**
 * Distributed rate-limit counters self-prune here. The longest window in use is
 * 1 hour (guest find/place), so any row whose window started more than this many
 * days ago is certainly dead — keeping a 2-day horizon needs no per-limiter
 * knowledge and leaves generous slack. Bounds `rate_limit_counters` to roughly
 * "active + last couple of days" so it never grows unbounded without its own cron.
 */
export const RATE_LIMIT_RETENTION_DAYS = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface UnverifiedCleanupResult {
  /** Accounts the warning phase claimed this run. */
  warned: number;
  /** Warning emails accepted by the transport. */
  warningEmailsSent: number;
  /** Accounts hard-deleted by the deletion phase. */
  deleted: number;
  /** login_attempts rows older than the 180-day retention, pruned. */
  prunedLoginAttempts: number;
  /** rate_limit_counters rows from windows older than the 2-day horizon, pruned. */
  prunedRateLimits: number;
}

export async function runUnverifiedCleanupJob(opts?: {
  now?: Date;
  logger?: Logger;
}): Promise<UnverifiedCleanupResult> {
  const db = getDb();
  const now = opts?.now ?? new Date();
  const logger = opts?.logger;

  const warnCutoff = new Date(now.getTime() - UNVERIFIED_WARNING_DAYS * DAY_MS);
  const deleteCutoff = new Date(
    now.getTime() - UNVERIFIED_RETENTION_DAYS * DAY_MS,
  );

  // ── Phase 1: day-6 warning (claim-then-send) ──────────────────────────────
  const claimed = await db
    .update(schema.users)
    .set({ unverifiedDeletionWarningAt: now })
    .where(
      and(
        eq(schema.users.role, "customer"),
        isNull(schema.users.emailVerifiedAt),
        isNull(schema.users.deletedAt),
        isNull(schema.users.unverifiedDeletionWarningAt),
        lte(schema.users.createdAt, warnCutoff),
        gt(schema.users.createdAt, deleteCutoff),
      ),
    )
    .returning();

  let warningEmailsSent = 0;
  for (const user of claimed) {
    // Best-effort display name. Unverified accounts normally have a profile
    // row from registration; a missing one degrades to a neutral greeting.
    let fullName: string | null = null;
    const [personal] = await db
      .select({ fullName: schema.customerProfiles.fullName })
      .from(schema.customerProfiles)
      .where(eq(schema.customerProfiles.userId, user.id))
      .limit(1);
    if (personal) {
      fullName = personal.fullName;
    } else {
      const [corp] = await db
        .select({ contactName: schema.corporateProfiles.contactName })
        .from(schema.corporateProfiles)
        .where(eq(schema.corporateProfiles.userId, user.id))
        .limit(1);
      if (corp) fullName = corp.contactName;
    }

    const { token } = await issueSignupVerificationToken({ userId: user.id });
    const ok = await sendAccountDeletionWarningEmail({
      to: user.email,
      fullName,
      token,
      deleteAfter: new Date(user.createdAt.getTime() + UNVERIFIED_RETENTION_DAYS * DAY_MS),
      logger,
    });
    if (ok) {
      warningEmailsSent += 1;
    } else {
      // Surrender the claim so the next daily run retries the courtesy
      // warning (deletion timing is unaffected either way).
      await db
        .update(schema.users)
        .set({ unverifiedDeletionWarningAt: null })
        .where(eq(schema.users.id, user.id));
      logger?.warn({ userId: user.id }, "unverified_warning_claim_compensated");
    }
  }

  // ── Phase 2: day-7 hard delete ────────────────────────────────────────────
  const deletedRows = await db
    .delete(schema.users)
    .where(
      and(
        eq(schema.users.role, "customer"),
        isNull(schema.users.emailVerifiedAt),
        isNull(schema.users.deletedAt),
        lte(schema.users.createdAt, deleteCutoff),
        // Defence in depth: ordering is verification-gated so this can't
        // match, but if the invariant ever breaks the FK ON DELETE SET NULL
        // would silently orphan a legally-retained order — refuse instead.
        sql`NOT EXISTS (SELECT 1 FROM ${schema.orders} WHERE ${schema.orders.customerId} = ${schema.users.id})`,
      ),
    )
    .returning();

  if (deletedRows.length > 0) {
    // User ids are opaque identifiers (no PII); emails stay out of logs.
    logger?.info(
      { userIds: deletedRows.map((u) => u.id) },
      "unverified_accounts_deleted",
    );
  }

  // ── Phase 3: login_attempts retention prune (Art. 5(1)(e)) ────────────────
  // Independent of accounts: rows reference attempts on real AND non-existent
  // emails alike. The lockout logic reads a 15-minute window, so a 180-day
  // horizon is pure audit margin — past it, the IP/user-agent rows must go.
  const retentionCutoff = new Date(
    now.getTime() - LOGIN_ATTEMPTS_RETENTION_DAYS * DAY_MS,
  );
  const prunedRows = await db
    .delete(schema.loginAttempts)
    .where(lt(schema.loginAttempts.attemptedAt, retentionCutoff))
    .returning();

  if (prunedRows.length > 0) {
    logger?.info(
      { count: prunedRows.length },
      "login_attempts_retention_pruned",
    );
  }

  // ── Phase 4: rate_limit_counters prune ────────────────────────────────────
  // The distributed limiters (lib/rate-limit-db.ts) leave one row per
  // (bucket, subject, window). Past windows are never read again, so anything
  // older than the 2-day horizon is dead weight — drop it. This is the table's
  // only janitor; no dedicated cron, same idempotent-sweep model as above.
  const rateLimitCutoff = new Date(
    now.getTime() - RATE_LIMIT_RETENTION_DAYS * DAY_MS,
  );
  const prunedRateLimitRows = await db
    .delete(schema.rateLimitCounters)
    .where(lt(schema.rateLimitCounters.windowStart, rateLimitCutoff))
    .returning();

  if (prunedRateLimitRows.length > 0) {
    logger?.info(
      { count: prunedRateLimitRows.length },
      "rate_limit_counters_pruned",
    );
  }

  return {
    warned: claimed.length,
    warningEmailsSent,
    deleted: deletedRows.length,
    prunedLoginAttempts: prunedRows.length,
    prunedRateLimits: prunedRateLimitRows.length,
  };
}
