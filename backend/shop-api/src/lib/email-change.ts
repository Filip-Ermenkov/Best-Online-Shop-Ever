import { randomBytes, createHash } from "node:crypto";
import {
  renderEmailChangeAlertEmail,
  renderEmailChangeVerifyEmail,
  renderEmailChangedEmail,
} from "@shop/email";
import { schema } from "@shop/db";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { Logger } from "pino";
import { getDb } from "./db.js";
import { getEmailTransport } from "./emails.js";
import { parseEnv } from "./env.js";
import { deleteAllSessionsForUser } from "./sessions.js";

/**
 * Email change — token issuance, send, consumption.
 *
 * Builds on the same patterns as password-reset.ts: 32-byte CSPRNG token,
 * SHA-256-at-rest, single-use, generic 400 across all failure cases,
 * all-other-tokens-invalidated on consume, all sessions dropped on consume.
 *
 * Storage is the same `email_verification_tokens` table the signup-
 * verification flow uses — distinguished by `kind = 'email_change'` and
 * carrying the proposed new address on `new_email`. The `users.email`
 * column is NOT updated until the verify-link is clicked; until then the
 * change exists only as a row in this table (matches the OWASP "store the
 * proposed-new email address as a proposed-new value" guidance).
 *
 * Differences vs password-reset, by design:
 *
 *   - The REQUEST endpoint is authenticated and requires current-password
 *     re-auth (OWASP "MFA may be appropriate for performing sensitive
 *     actions"; we don't yet have MFA so password re-auth is the strongest
 *     local equivalent). Rate-limit decisions still happen internally — the
 *     authenticated user can see whether their own request hit a 429.
 *
 *   - At REQUEST time we send TWO emails: the verify link to the NEW
 *     address (only the holder of the new mailbox can complete the change)
 *     AND an alert to the OLD address (defence in depth: if the request was
 *     unauthorised, the legitimate owner gets a real-time heads-up via the
 *     out-of-band channel they still control). Both are best-effort.
 *
 *   - On verify, we:
 *       1. Rotate users.email to the new address.
 *       2. Set users.email_verified_at = now() — the click proves the new
 *          mailbox is controlled by the user.
 *       3. Mark every other live email-change token for this user consumed
 *          (parallel-token phishing defence, same as password-reset).
 *       4. Drop ALL sessions for the user (NIST SP 800-63B-4 + OWASP). The
 *          user must re-log-in with the new email everywhere.
 *       5. Best-effort send a post-action notification to the OLD address.
 *
 *   - The VERIFY endpoint is public (the email link IS the proof of
 *     control of the new mailbox — same posture as the password-reset
 *     verify endpoint).
 */

const TOKEN_BYTES = 32;
const EMAIL_CHANGE_TOKEN_LIFETIME_MS = 60 * 60 * 1000; // 1 hour

const REQUEST_HOURLY_LIMIT = 3;
const REQUEST_DAILY_LIMIT = 5;

export interface IssueEmailChangeTokenInput {
  userId: string;
  newEmail: string;
}

export interface IssuedEmailChangeToken {
  /** Plaintext, base64url. 43 chars for 32 bytes. Returned ONCE. */
  token: string;
  /** SHA-256 hex of the token, persisted to email_verification_tokens. */
  tokenHash: string;
  expiresAt: Date;
}

export async function issueEmailChangeToken(
  input: IssueEmailChangeTokenInput,
): Promise<IssuedEmailChangeToken> {
  const db = getDb();
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const tokenHash = sha256Hex(token);
  const expiresAt = new Date(Date.now() + EMAIL_CHANGE_TOKEN_LIFETIME_MS);

  await db.insert(schema.emailVerificationTokens).values({
    tokenHash,
    userId: input.userId,
    kind: "email_change",
    newEmail: input.newEmail,
    expiresAt,
  });

  return { token, tokenHash, expiresAt };
}

/**
 * Rate-limit decision for /auth/email-change/request.
 *
 * Counts both unexpired AND expired/consumed rows of kind='email_change'
 * — every issuance counts toward the cap, regardless of whether the user
 * actually clicked through. Same rationale as the forgot-password limiter:
 * otherwise an attacker could spam by abandoning each token.
 */
export interface EmailChangeRequestDecision {
  allowed: boolean;
  reason?: "hourly" | "daily";
}

export async function evaluateEmailChangeRateLimit(
  userId: string,
): Promise<EmailChangeRequestDecision> {
  const db = getDb();
  const now = Date.now();
  const oneHourAgo = new Date(now - 60 * 60 * 1000);
  const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);

  const rows = await db
    .select({ createdAt: schema.emailVerificationTokens.createdAt })
    .from(schema.emailVerificationTokens)
    .where(
      and(
        eq(schema.emailVerificationTokens.userId, userId),
        eq(schema.emailVerificationTokens.kind, "email_change"),
      ),
    )
    .orderBy(desc(schema.emailVerificationTokens.createdAt))
    .limit(REQUEST_DAILY_LIMIT + 1);

  const inHour = rows.filter((r) => r.createdAt >= oneHourAgo).length;
  if (inHour >= REQUEST_HOURLY_LIMIT) {
    return { allowed: false, reason: "hourly" };
  }
  const inDay = rows.filter((r) => r.createdAt >= oneDayAgo).length;
  if (inDay >= REQUEST_DAILY_LIMIT) {
    return { allowed: false, reason: "daily" };
  }
  return { allowed: true };
}

/**
 * Send the verification email to the NEW address. Best-effort — failures
 * are logged, not thrown. Same defensive posture as the verification slice:
 * an SES outage must not surface as a 5xx on a user-initiated action; the
 * user can re-request from the change-email page if no mail arrives.
 */
export interface SendEmailChangeVerifyInput {
  to: string;
  token: string;
  fullName?: string | null;
  logger?: Logger;
}

export async function sendEmailChangeVerifyEmail(
  input: SendEmailChangeVerifyInput,
): Promise<{ ok: true; messageId: string } | { ok: false; error: unknown }> {
  const env = parseEnv();
  const verifyUrl = `${env.PUBLIC_APP_BASE_URL}/account/email-change/verify?token=${encodeURIComponent(input.token)}`;
  const email = renderEmailChangeVerifyEmail({
    to: input.to,
    verifyUrl,
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
 * Send the request-time ALERT to the OLD address. Best-effort.
 *
 * No actionable link in this email — the recipient just needs to know that
 * a change was requested. "Doing nothing" is the safe path; if they
 * misclick a link in an alert email we just create another phishing vector.
 */
export interface SendEmailChangeAlertInput {
  to: string;
  newEmail: string;
  fullName?: string | null;
  requestedAt?: Date;
  logger?: Logger;
}

export async function sendEmailChangeAlertEmail(
  input: SendEmailChangeAlertInput,
): Promise<{ ok: true; messageId: string } | { ok: false; error: unknown }> {
  const env = parseEnv();
  const supportEmail = extractAddress(env.EMAIL_FROM);
  const email = renderEmailChangeAlertEmail({
    to: input.to,
    newEmail: input.newEmail,
    fullName: input.fullName ?? null,
    ...(input.requestedAt !== undefined && { requestedAt: input.requestedAt }),
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
 * Look up a token and atomically rotate the user's email + verify the new
 * address + invalidate all other live email-change tokens + drop all
 * sessions. Returns enough information for the route layer to send the
 * post-action notification to the OLD address.
 *
 *   - Unknown / wrong / expired / already-consumed tokens → return null.
 *   - The destination email being taken between request and verify (a
 *     concurrent registration of the same address) → return null. We
 *     deliberately do NOT carve out a distinct error for this — surfacing
 *     it would let an attacker probe email registration via token
 *     consumption attempts (same enumeration argument as the request side).
 *
 * Argon2id-equivalent work isn't needed here (we don't hash a password on
 * verify), so everything fits inside a single transaction.
 */
export interface ConsumeEmailChangeTokenResult {
  userId: string;
  oldEmail: string;
  newEmail: string;
}

export async function consumeEmailChangeToken(
  rawToken: string,
): Promise<ConsumeEmailChangeTokenResult | null> {
  const db = getDb();
  const tokenHash = sha256Hex(rawToken);

  const result = await db.transaction(async (tx) => {
    const now = new Date();
    const rows = await tx
      .select({
        tokenHash: schema.emailVerificationTokens.tokenHash,
        userId: schema.emailVerificationTokens.userId,
        newEmail: schema.emailVerificationTokens.newEmail,
        userEmail: schema.users.email,
      })
      .from(schema.emailVerificationTokens)
      .innerJoin(
        schema.users,
        eq(schema.users.id, schema.emailVerificationTokens.userId),
      )
      .where(
        and(
          eq(schema.emailVerificationTokens.tokenHash, tokenHash),
          eq(schema.emailVerificationTokens.kind, "email_change"),
          gt(schema.emailVerificationTokens.expiresAt, now),
          isNull(schema.emailVerificationTokens.consumedAt),
          isNull(schema.users.deletedAt),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row || !row.newEmail) return null;

    // Race-guard: between the request that issued this token and now, a
    // different user could have registered with the proposed address (or
    // re-claimed an existing one if the column ever gets a uniqueness
    // constraint added). We re-check that the new address is still
    // available to this user. If not, return null and the caller responds
    // with the same generic 400 as any other dead-link case — no leak
    // about WHY it failed.
    const conflictingRows = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(
        and(
          eq(schema.users.email, row.newEmail),
          isNull(schema.users.deletedAt),
        ),
      )
      .limit(1);
    const conflict = conflictingRows[0];
    if (conflict && conflict.id !== row.userId) return null;

    // Mark THIS token consumed first (audit-log ordering).
    await tx
      .update(schema.emailVerificationTokens)
      .set({ consumedAt: now })
      .where(eq(schema.emailVerificationTokens.tokenHash, tokenHash));

    // Kill every OTHER live email-change token for this user. Same
    // parallel-token-phishing defence as password-reset: an attacker who
    // tricked the user into requesting twice could otherwise still hold a
    // valid second token AFTER the legitimate change completes.
    await tx
      .update(schema.emailVerificationTokens)
      .set({ consumedAt: now })
      .where(
        and(
          eq(schema.emailVerificationTokens.userId, row.userId),
          eq(schema.emailVerificationTokens.kind, "email_change"),
          isNull(schema.emailVerificationTokens.consumedAt),
        ),
      );

    // Rotate the email AND mark verified — the click proves the new
    // mailbox is controlled. If the row was somehow unverified before
    // (shouldn't happen in normal use because email-change is a settings-
    // page action, but defensively), we land verified.
    await tx
      .update(schema.users)
      .set({ email: row.newEmail, emailVerifiedAt: now })
      .where(eq(schema.users.id, row.userId));

    return {
      userId: row.userId,
      oldEmail: row.userEmail,
      newEmail: row.newEmail,
    };
  });

  if (!result) return null;

  // Sessions live in a separate table; drop them post-commit for the same
  // reason as password-reset (DbClient union typing on .delete() inside the
  // txn is awkward, and the wider security window is milliseconds).
  await deleteAllSessionsForUser(result.userId);
  return result;
}

/**
 * Send the post-change notification to the OLD address. Best-effort.
 *
 * Mirrors password-changed in spirit: a final audit-trail email in the
 * recipient's inbox so an unauthorised change still surfaces to the
 * original owner. The body includes the new address so the recipient knows
 * who they need to talk to support about.
 */
export interface SendEmailChangedNotificationInput {
  to: string;
  newEmail: string;
  fullName?: string | null;
  changedAt?: Date;
  logger?: Logger;
}

export async function sendEmailChangedNotification(
  input: SendEmailChangedNotificationInput,
): Promise<{ ok: true; messageId: string } | { ok: false; error: unknown }> {
  const env = parseEnv();
  const supportEmail = extractAddress(env.EMAIL_FROM);
  const email = renderEmailChangedEmail({
    to: input.to,
    newEmail: input.newEmail,
    fullName: input.fullName ?? null,
    ...(input.changedAt !== undefined && { changedAt: input.changedAt }),
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
 * Pure read: is this email-change token live? Returns the destination
 * email on success so the verify page can show "you are about to change
 * to X" copy. Returns null in every failure case (unknown/expired/
 * consumed/user-deleted/destination-now-conflicting).
 *
 * Symmetric to validateResetToken — see that helper's doc for the rationale
 * on why this is safe to be public (256-bit token entropy makes probing
 * infeasible). Showing the destination email to whoever holds the token is
 * not a leak: the token reaches the recipient mailbox via the verify email
 * itself, and the verify email already plainly tells them the change is to
 * THIS address.
 */
export async function validateEmailChangeToken(
  rawToken: string,
): Promise<{ newEmail: string } | null> {
  const db = getDb();
  const tokenHash = sha256Hex(rawToken);
  const now = new Date();
  const rows = await db
    .select({
      newEmail: schema.emailVerificationTokens.newEmail,
      userId: schema.emailVerificationTokens.userId,
    })
    .from(schema.emailVerificationTokens)
    .innerJoin(
      schema.users,
      eq(schema.users.id, schema.emailVerificationTokens.userId),
    )
    .where(
      and(
        eq(schema.emailVerificationTokens.tokenHash, tokenHash),
        eq(schema.emailVerificationTokens.kind, "email_change"),
        gt(schema.emailVerificationTokens.expiresAt, now),
        isNull(schema.emailVerificationTokens.consumedAt),
        isNull(schema.users.deletedAt),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row || !row.newEmail) return null;

  // Late conflict check — if the new address has been taken between
  // request and check, treat the token as dead. (See consume for the
  // matching guard.)
  const conflictingRows = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(
      and(eq(schema.users.email, row.newEmail), isNull(schema.users.deletedAt)),
    )
    .limit(1);
  const conflict = conflictingRows[0];
  if (conflict && conflict.id !== row.userId) return null;

  return { newEmail: row.newEmail };
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
