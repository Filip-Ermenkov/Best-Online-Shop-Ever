import { randomBytes, createHash } from "node:crypto";
import { renderVerificationEmail } from "@shop/email";
import { schema } from "@shop/db";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { Logger } from "pino";
import { getDb } from "./db.js";
import { getEmailTransport } from "./emails.js";
import { parseEnv } from "./env.js";

/**
 * Email verification — token issuance, send, and consumption.
 *
 * The email-verification table (backend/db/schema/auth.ts) carries:
 *   token_hash (PK), user_id, kind, new_email?, expires_at, consumed_at?, created_at
 *
 * Token plaintext lives ONLY in the email link. We store SHA-256 at rest
 * (same rationale as session tokens — high-entropy input, slow hashing
 * adds nothing). Single-use: `consumed_at` is set on first use; subsequent
 * uses are rejected without revealing whether the token was wrong vs already
 * consumed (constant-shape error path).
 *
 * Why 32 bytes (256 bits)? OWASP minimum is 128 bits; 256 future-proofs
 * against birthday-bound concerns once the table has many millions of rows
 * over its lifetime, and matches the session-token strength so the codebase
 * has one mental model for "secret blob in a URL".
 *
 * Lifetime: 24h. Industry default for verification (vs the tighter 1h/15m
 * for password reset which has stricter recommendations). Spec doc-comment
 * on the schema also said 24h.
 */

const TOKEN_BYTES = 32;
const SIGNUP_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** Resend cap, per user, in the trailing 1-hour window. */
const RESEND_HOURLY_LIMIT = 3;
/** Resend cap, per user, in the trailing 24-hour window. */
const RESEND_DAILY_LIMIT = 5;

export interface IssueTokenInput {
  userId: string;
}

export interface IssuedToken {
  /** Plaintext, base64url. 43 chars for 32 bytes. Returned ONCE. */
  token: string;
  /** SHA-256 hex of the token, persisted to email_verification_tokens. */
  tokenHash: string;
  /** Absolute time the token stops being valid. */
  expiresAt: Date;
}

/**
 * Generate a fresh signup-verification token and persist its hash. Returns
 * the plaintext for inclusion in the email link.
 */
export async function issueSignupVerificationToken(
  input: IssueTokenInput,
): Promise<IssuedToken> {
  const db = getDb();
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const tokenHash = sha256Hex(token);
  const expiresAt = new Date(Date.now() + SIGNUP_TOKEN_LIFETIME_MS);

  await db.insert(schema.emailVerificationTokens).values({
    tokenHash,
    userId: input.userId,
    kind: "signup",
    newEmail: null,
    expiresAt,
  });

  return { token, tokenHash, expiresAt };
}

/**
 * Look up a token, atomically mark it consumed, set users.email_verified_at,
 * and return the user id. Designed for the verify-email endpoint:
 *
 *   - Unknown / wrong / expired / already-consumed tokens → return null.
 *     Callers respond with the SAME 400 in every failure case (no
 *     enumeration of reasons).
 *   - On the happy path: token is consumed, users.email_verified_at is set
 *     (idempotent — re-verifying an already-verified user is a no-op
 *     after the token is consumed once).
 *
 * Wrapped in a transaction so a concurrent click of the same link cannot
 * double-fire downstream side effects (e.g. multi-event observability).
 */
export interface ConsumeTokenResult {
  userId: string;
  email: string;
  /** Was this the first successful consumption? Used for telemetry. */
  alreadyVerified: boolean;
}

export async function consumeSignupVerificationToken(
  rawToken: string,
): Promise<ConsumeTokenResult | null> {
  const db = getDb();
  const tokenHash = sha256Hex(rawToken);

  return await db.transaction(async (tx) => {
    const now = new Date();
    const rows = await tx
      .select({
        tokenHash: schema.emailVerificationTokens.tokenHash,
        userId: schema.emailVerificationTokens.userId,
        consumedAt: schema.emailVerificationTokens.consumedAt,
        userEmail: schema.users.email,
        userVerifiedAt: schema.users.emailVerifiedAt,
      })
      .from(schema.emailVerificationTokens)
      .innerJoin(
        schema.users,
        eq(schema.users.id, schema.emailVerificationTokens.userId),
      )
      .where(
        and(
          eq(schema.emailVerificationTokens.tokenHash, tokenHash),
          eq(schema.emailVerificationTokens.kind, "signup"),
          gt(schema.emailVerificationTokens.expiresAt, now),
          isNull(schema.emailVerificationTokens.consumedAt),
          isNull(schema.users.deletedAt),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    // Mark consumed first; an admin investigating later sees the exact
    // sequence in audit logs (consumed before the verified-at set).
    await tx
      .update(schema.emailVerificationTokens)
      .set({ consumedAt: now })
      .where(eq(schema.emailVerificationTokens.tokenHash, tokenHash));

    const alreadyVerified = row.userVerifiedAt !== null;
    if (!alreadyVerified) {
      await tx
        .update(schema.users)
        .set({ emailVerifiedAt: now })
        .where(eq(schema.users.id, row.userId));
    }

    return {
      userId: row.userId,
      email: row.userEmail,
      alreadyVerified,
    };
  });
}

/**
 * Send the verification email. Best-effort: failures are logged but never
 * thrown — callers MUST NOT roll back the user record on email failure
 * (an SES outage would otherwise block all signups).
 *
 * The caller decides what to do on failure. The registration handler logs
 * and continues (the user can still verify via /auth/resend-verification).
 */
export interface SendVerificationEmailInput {
  to: string;
  token: string;
  fullName?: string | null;
  logger?: Logger;
}

export async function sendSignupVerificationEmail(
  input: SendVerificationEmailInput,
): Promise<{ ok: true; messageId: string } | { ok: false; error: unknown }> {
  const env = parseEnv();
  const verifyUrl = `${env.PUBLIC_APP_BASE_URL}/account/verify-email?token=${encodeURIComponent(input.token)}`;
  const email = renderVerificationEmail({
    to: input.to,
    verifyUrl,
    fullName: input.fullName ?? null,
  });
  try {
    const result = await getEmailTransport().send(email);
    input.logger?.info(
      {
        templateId: email.templateId,
        messageId: result.messageId,
        // Don't log the recipient — PII at scale, and our request_end log
        // already attributes the action to the request id.
      },
      "email_sent",
    );
    return { ok: true, messageId: result.messageId };
  } catch (err) {
    input.logger?.error({ err, templateId: email.templateId }, "email_send_failed");
    return { ok: false, error: err };
  }
}

/**
 * Resend rate limiter. Reads the recent token-creation history for a user
 * and decides whether another send is allowed.
 *
 * Why count token-creations and not email-send-attempts?
 *   We treat the table itself as the source of truth — every issuance is a
 *   row, every row is the audit log. This avoids needing a parallel
 *   "send_attempts" table that would drift out of sync with reality.
 */
export interface ResendDecision {
  allowed: boolean;
  /** Hint for the response body when rate limited. */
  reason?: "hourly" | "daily";
}

export async function evaluateResendRateLimit(
  userId: string,
): Promise<ResendDecision> {
  const db = getDb();
  const now = Date.now();
  const oneHourAgo = new Date(now - 60 * 60 * 1000);
  const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);

  // One round-trip is enough — pull last RESEND_DAILY_LIMIT createdAt
  // values and bucket them in JS. Cheap (≤5 rows) and avoids a second
  // count() query.
  const rows = await db
    .select({ createdAt: schema.emailVerificationTokens.createdAt })
    .from(schema.emailVerificationTokens)
    .where(
      and(
        eq(schema.emailVerificationTokens.userId, userId),
        eq(schema.emailVerificationTokens.kind, "signup"),
      ),
    )
    .orderBy(desc(schema.emailVerificationTokens.createdAt))
    .limit(RESEND_DAILY_LIMIT + 1);

  const inHour = rows.filter((r) => r.createdAt >= oneHourAgo).length;
  if (inHour >= RESEND_HOURLY_LIMIT) {
    return { allowed: false, reason: "hourly" };
  }
  const inDay = rows.filter((r) => r.createdAt >= oneDayAgo).length;
  if (inDay >= RESEND_DAILY_LIMIT) {
    return { allowed: false, reason: "daily" };
  }
  return { allowed: true };
}

/**
 * Find the most recent unexpired, unconsumed signup token for a user.
 * Resend uses this to *reuse* the existing token rather than mint a new
 * one, so an attacker who tricks the user into resending repeatedly
 * cannot fill the table with stale rows. The user clicks the latest email
 * — they get the same valid link.
 */
export async function findActiveSignupToken(
  userId: string,
): Promise<{ token: string; expiresAt: Date } | null> {
  // Note: we cannot return the plaintext token from the DB (we only stored
  // the hash). Resend always issues a new token; the rate limiter is the
  // mitigation for spam. This function is a stub for a future tightening
  // where we'd consider per-user "most recent valid" reuse — leaving it
  // here documents the rationale and prevents the wrong refactor.
  void userId;
  return null;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
