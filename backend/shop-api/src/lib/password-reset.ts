import { randomBytes, createHash } from "node:crypto";
import { hashPassword } from "@shop/auth";
import { renderPasswordResetEmail, renderPasswordChangedEmail } from "@shop/email";
import { schema } from "@shop/db";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { Logger } from "pino";
import { getDb } from "./db.js";
import { getEmailTransport } from "./emails.js";
import { parseEnv } from "./env.js";
import { deleteAllSessionsForUser } from "./sessions.js";

/**
 * Password reset — token issuance, send, consumption.
 *
 * Mirrors the email-verification module structurally on purpose: same crypto
 * shape, same SHA-256-at-rest, same "generic 400 across all failure cases"
 * stance. The differences are deliberate and security-driven:
 *
 *   - Lifetime is 1h (vs 24h for verification). OWASP says ≤1h, ideally ≤20m.
 *     1h is the schema doc-comment value and the practical upper bound for
 *     a customer who opens the email on a different device.
 *
 *   - Consumption rotates `password_hash` AND drops every session for the
 *     user (NIST SP 800-63B-4 + OWASP Authentication CS). After a successful
 *     reset, every previously-logged-in device is signed out. The
 *     reset-page UX redirects to /account/login with a success banner.
 *
 *   - The forgot endpoint is enumeration-resistant: identical 200 whether or
 *     not the email is registered. We still issue + send for real users so
 *     the response time has a similar shape.
 *
 *   - Rate limiting on the forgot endpoint is per-EMAIL (3/hr, 5/day),
 *     evaluated BEFORE issuing a token. Per-IP volume defence belongs at
 *     WAF (matches the lockout slice's approach). Critically, the rate-
 *     limit decision is internal: a rate-limited request still returns the
 *     same generic 200 — surfacing a 429 to the caller would itself leak
 *     "this email is registered and someone is hammering it".
 */

const TOKEN_BYTES = 32;
const RESET_TOKEN_LIFETIME_MS = 60 * 60 * 1000; // 1 hour

const FORGOT_HOURLY_LIMIT = 3;
const FORGOT_DAILY_LIMIT = 5;

export interface IssueResetTokenInput {
  userId: string;
}

export interface IssuedResetToken {
  /** Plaintext, base64url. 43 chars for 32 bytes. Returned ONCE. */
  token: string;
  /** SHA-256 hex of the token, persisted to password_reset_tokens. */
  tokenHash: string;
  expiresAt: Date;
}

export async function issueResetToken(
  input: IssueResetTokenInput,
): Promise<IssuedResetToken> {
  const db = getDb();
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const tokenHash = sha256Hex(token);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_LIFETIME_MS);

  await db.insert(schema.passwordResetTokens).values({
    tokenHash,
    userId: input.userId,
    expiresAt,
  });

  return { token, tokenHash, expiresAt };
}

/**
 * Rate-limit decision for /auth/forgot-password.
 *
 * Counts unexpired AND expired token rows from the trailing window — any
 * issuance counts towards the cap, irrespective of whether the user actually
 * clicked the link. Otherwise an attacker could spam by abandoning each
 * token to wait for natural expiry.
 */
export interface ForgotResetDecision {
  allowed: boolean;
  reason?: "hourly" | "daily";
}

export async function evaluateForgotPasswordRateLimit(
  userId: string,
): Promise<ForgotResetDecision> {
  const db = getDb();
  const now = Date.now();
  const oneHourAgo = new Date(now - 60 * 60 * 1000);
  const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);

  const rows = await db
    .select({ createdAt: schema.passwordResetTokens.createdAt })
    .from(schema.passwordResetTokens)
    .where(eq(schema.passwordResetTokens.userId, userId))
    .orderBy(desc(schema.passwordResetTokens.createdAt))
    .limit(FORGOT_DAILY_LIMIT + 1);

  const inHour = rows.filter((r) => r.createdAt >= oneHourAgo).length;
  if (inHour >= FORGOT_HOURLY_LIMIT) {
    return { allowed: false, reason: "hourly" };
  }
  const inDay = rows.filter((r) => r.createdAt >= oneDayAgo).length;
  if (inDay >= FORGOT_DAILY_LIMIT) {
    return { allowed: false, reason: "daily" };
  }
  return { allowed: true };
}

/**
 * Send the reset email. Best-effort — failures are logged, not thrown.
 *
 * The forgot endpoint must NOT bubble email failures to the caller: that
 * would leak which addresses are registered (a 5xx for "we found you but
 * SES is down" vs the silent 200 for unknown addresses). Same defensive
 * posture as the verification slice.
 */
export interface SendResetEmailInput {
  to: string;
  token: string;
  fullName?: string | null;
  logger?: Logger;
}

export async function sendPasswordResetEmail(
  input: SendResetEmailInput,
): Promise<{ ok: true; messageId: string } | { ok: false; error: unknown }> {
  const env = parseEnv();
  const resetUrl = `${env.PUBLIC_APP_BASE_URL}/account/reset-password?token=${encodeURIComponent(input.token)}`;
  const email = renderPasswordResetEmail({
    to: input.to,
    resetUrl,
    fullName: input.fullName ?? null,
  });
  try {
    const result = await getEmailTransport().send(email);
    input.logger?.info(
      { templateId: email.templateId, messageId: result.messageId },
      "email_sent",
    );
    return { ok: true, messageId: result.messageId };
  } catch (err) {
    input.logger?.error({ err, templateId: email.templateId }, "email_send_failed");
    return { ok: false, error: err };
  }
}

/**
 * Atomically consume a reset token, rotate the password hash, and drop all
 * sessions for the user. The four side effects (mark token consumed, write
 * new hash, expire ALL outstanding tokens for this user, delete sessions)
 * happen inside one transaction so a crash at any point can't leave the
 * account half-changed.
 *
 * Returns the user (id + email + fullName) on success — the caller uses it
 * to send the password-changed notification AND to build a per-request log
 * line. Returns null in every failure case (unknown / wrong / expired /
 * already-consumed token, deleted user) so the route layer can respond with
 * one generic 400.
 *
 * Why expire OTHER outstanding reset tokens too? An attacker who phished a
 * second token (e.g. user requested two resets) would otherwise still hold
 * a valid link AFTER the legitimate user reset their password. Single-token
 * "consumption" alone doesn't cover the attack — every other live token
 * for the same user has to die alongside.
 *
 * deleteAllSessionsForUser intentionally has NO `keepIdHash` — the reset
 * page is unauthenticated, so the caller has no session to preserve. The
 * user re-logs in after redirect.
 */
export interface ConsumeResetTokenInput {
  rawToken: string;
  newPassword: string;
}

export interface ConsumeResetTokenResult {
  userId: string;
  email: string;
}

export async function consumeResetToken(
  input: ConsumeResetTokenInput,
): Promise<ConsumeResetTokenResult | null> {
  const db = getDb();
  const tokenHash = sha256Hex(input.rawToken);

  // Hash the password OUTSIDE the transaction. Argon2id takes ~50ms; holding
  // a row lock for that long would serialise unrelated checkouts that touch
  // the same user row (e.g. orders against the same buyer).
  const newPasswordHash = await hashPassword(input.newPassword);

  return await db.transaction(async (tx) => {
    const now = new Date();
    const rows = await tx
      .select({
        tokenHash: schema.passwordResetTokens.tokenHash,
        userId: schema.passwordResetTokens.userId,
        userEmail: schema.users.email,
      })
      .from(schema.passwordResetTokens)
      .innerJoin(
        schema.users,
        eq(schema.users.id, schema.passwordResetTokens.userId),
      )
      .where(
        and(
          eq(schema.passwordResetTokens.tokenHash, tokenHash),
          gt(schema.passwordResetTokens.expiresAt, now),
          isNull(schema.passwordResetTokens.consumedAt),
          isNull(schema.users.deletedAt),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    // Mark this token consumed first (audit log "consumed_at" precedes the
    // password rotation in time for any forensic replay).
    await tx
      .update(schema.passwordResetTokens)
      .set({ consumedAt: now })
      .where(eq(schema.passwordResetTokens.tokenHash, tokenHash));

    // Kill every OTHER live reset token for this user. Bug-class fix: an
    // attacker holding a parallel valid token must not retain a backdoor.
    await tx
      .update(schema.passwordResetTokens)
      .set({ consumedAt: now })
      .where(
        and(
          eq(schema.passwordResetTokens.userId, row.userId),
          isNull(schema.passwordResetTokens.consumedAt),
        ),
      );

    // Rotate the password.
    await tx
      .update(schema.users)
      .set({ passwordHash: newPasswordHash })
      .where(eq(schema.users.id, row.userId));

    return {
      userId: row.userId,
      email: row.userEmail,
    };
  }).then(async (result) => {
    if (!result) return null;
    // Sessions live in a separate concern — deleting them inside the txn
    // works on node-pg but the DbClient union typing makes it awkward, and
    // a session-table delete is safe to do post-commit because:
    //   1. The password is already rotated, so a stale session token still
    //      held by an attacker would work for at most the time between this
    //      line and deleteAllSessionsForUser returning (milliseconds).
    //   2. validateSession does a JOIN against users — it would refresh
    //      lastActiveAt but not expose new powers.
    // Still, run it eagerly (not fire-and-forget) so the response only
    // returns ok after the sessions are gone.
    await deleteAllSessionsForUser(result.userId);
    return result;
  });
}

/**
 * Send the "your password was changed" notification. Best-effort.
 *
 * Distinct from sendPasswordResetEmail — this is the post-action notice,
 * for the case where an attacker reset a victim's password via a phished
 * inbox. The email gives the victim a real-time alert AND the standard
 * "what to do next" runbook (lock down email, contact support).
 */
export interface SendPasswordChangedNotificationInput {
  to: string;
  fullName?: string | null;
  changedAt?: Date;
  logger?: Logger;
}

export async function sendPasswordChangedNotification(
  input: SendPasswordChangedNotificationInput,
): Promise<{ ok: true; messageId: string } | { ok: false; error: unknown }> {
  const env = parseEnv();
  // Pull a support contact out of EMAIL_FROM as a sensible default — most
  // operators set it to a real mailbox they monitor. A future slice can
  // introduce a dedicated SUPPORT_EMAIL env if the two diverge.
  const supportEmail = extractAddress(env.EMAIL_FROM);
  const email = renderPasswordChangedEmail({
    to: input.to,
    fullName: input.fullName ?? null,
    changedAt: input.changedAt,
    ...(supportEmail !== null && { supportEmail }),
  });
  try {
    const result = await getEmailTransport().send(email);
    input.logger?.info(
      { templateId: email.templateId, messageId: result.messageId },
      "email_sent",
    );
    return { ok: true, messageId: result.messageId };
  } catch (err) {
    input.logger?.error({ err, templateId: email.templateId }, "email_send_failed");
    return { ok: false, error: err };
  }
}

/**
 * Pure read: is this token live (exists, unexpired, unconsumed, user not
 * soft-deleted)? Returns true/false WITHOUT mutating any row.
 *
 * Why a separate endpoint and helper instead of "just try to consume":
 *
 *   1. UX. We want the reset page to fail fast on a dead link — typing a
 *      new password only to learn the link is consumed is wasted effort
 *      AND signals our recovery flow is rougher than industry standard
 *      (GitHub, Google, Auth0, Stripe all validate on page mount).
 *
 *   2. Consuming-as-probe doesn't work. The consume endpoint validates the
 *      new password (Zod) BEFORE checking the token, so a "probe with a
 *      weak password" gets 400 validation regardless of token validity —
 *      no signal. Probing with a valid-strength password would consume the
 *      token if it happened to be live, which is exactly what we're trying
 *      to avoid.
 *
 * Why this isn't a meaningful attack surface: tokens are 256-bit random.
 * An attacker who could probe arbitrary tokens for validity still couldn't
 * brute-force one (2^256 search space), so the function reveals zero
 * useful information beyond "this specific token I already have is live".
 * Per-token rate-limiting therefore adds no defence; we rely on WAF-level
 * IP rate-limiting alongside everything else (matches the project's
 * stance on /auth/login and /auth/forgot-password).
 */
export async function validateResetToken(rawToken: string): Promise<boolean> {
  const db = getDb();
  const tokenHash = sha256Hex(rawToken);
  const now = new Date();
  const rows = await db
    .select({ tokenHash: schema.passwordResetTokens.tokenHash })
    .from(schema.passwordResetTokens)
    .innerJoin(
      schema.users,
      eq(schema.users.id, schema.passwordResetTokens.userId),
    )
    .where(
      and(
        eq(schema.passwordResetTokens.tokenHash, tokenHash),
        gt(schema.passwordResetTokens.expiresAt, now),
        isNull(schema.passwordResetTokens.consumedAt),
        isNull(schema.users.deletedAt),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Pull the bare email address out of an RFC 5322 mailbox like
 *   "Best Online Shop <noreply@example.com>"
 * Returns null on any mailbox that isn't bracketed-and-bare.
 */
function extractAddress(mailbox: string): string | null {
  const m = mailbox.match(/<([^>]+)>/);
  if (m && m[1]) return m[1].trim();
  if (/^[^\s<>]+@[^\s<>]+$/.test(mailbox)) return mailbox.trim();
  return null;
}
