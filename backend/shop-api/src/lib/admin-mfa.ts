import {
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  loadMfaKey,
  totpAuthUri,
  verifyRecoveryCode,
  verifyTotp,
} from "@shop/auth";
import { schema } from "@shop/db";
import { and, count, eq, gte, isNull } from "drizzle-orm";
import { getDb } from "./db.js";
import { parseEnv } from "./env.js";

/**
 * Admin MFA — the stateful (DB-touching) half of the admin TOTP flow. The pure
 * crypto lives in @shop/auth; this module composes it with the database:
 * secret storage, the RFC 6238 replay-step persistence, recovery-code
 * consumption, and the admin-specific brute-force lockout.
 *
 * Posture (docs/ARCHITECTURE.md §5.1, §3.4):
 *   - Mandatory TOTP for the single admin account (AAL2 — password + TOTP).
 *   - 30-minute / 5-failure lockout (stricter than the 15-minute customer one).
 *   - The TOTP secret is AES-256-GCM encrypted at rest; the key is out-of-band
 *     in SSM, never in the DB.
 *   - Every code is single-use even within its skew window (replay guard).
 */

// Admin lockout is stricter than the customer one (lib/lockout.ts: 15 min / 5).
// docs/ARCHITECTURE.md §5.1 admin row: "5-fail 30-min lockout".
const ADMIN_LOCKOUT_WINDOW_MS = 30 * 60 * 1000;
const ADMIN_LOCKOUT_THRESHOLD = 5;

/** Login → MFA challenge lifetime: 5 minutes is ample to read a code. */
export const CHALLENGE_TTL_LOGIN_SEC = 5 * 60;
/** Enrolment challenge lifetime: 10 minutes (scan QR + confirm a code). */
export const CHALLENGE_TTL_ENROLL_SEC = 10 * 60;

export interface AdminKeys {
  /** AES-256 key for secret-at-rest. */
  encKey: Buffer;
  /** HMAC key for challenge tokens. */
  challengeKey: string;
  /** otpauth issuer label. */
  issuer: string;
}

/**
 * Resolve + validate the admin MFA keys. Throws (→ 500 on the admin route only)
 * if unconfigured, so a misconfigured deployment fails loudly on the admin
 * surface without touching the storefront.
 */
export function getAdminKeys(): AdminKeys {
  const env = parseEnv();
  const encKey = loadMfaKey(env.ADMIN_MFA_ENCRYPTION_KEY);
  if (!env.ADMIN_MFA_CHALLENGE_KEY) {
    throw new Error("ADMIN_MFA_CHALLENGE_KEY is not configured");
  }
  return {
    encKey,
    challengeKey: env.ADMIN_MFA_CHALLENGE_KEY,
    issuer: env.ADMIN_MFA_ISSUER,
  };
}

export interface AdminRow {
  id: string;
  email: string;
  passwordHash: string;
  role: "admin" | "customer";
  emailVerifiedAt: Date | null;
  deletedAt: Date | null;
  mfaEnabled: boolean;
  mfaSecretEncrypted: string | null;
  mfaLastUsedStep: number | null;
}

/** Fetch a user by (lower-cased) email with the columns the admin flow needs. */
export async function findUserByEmail(email: string): Promise<AdminRow | null> {
  const db = getDb();
  const [row] = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      passwordHash: schema.users.passwordHash,
      role: schema.users.role,
      emailVerifiedAt: schema.users.emailVerifiedAt,
      deletedAt: schema.users.deletedAt,
      mfaEnabled: schema.users.mfaEnabled,
      mfaSecretEncrypted: schema.users.mfaSecretEncrypted,
      mfaLastUsedStep: schema.users.mfaLastUsedStep,
    })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);
  return row ?? null;
}

/** Fetch by id (used after a challenge resolves a userId). */
export async function findUserById(id: string): Promise<AdminRow | null> {
  const db = getDb();
  const [row] = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      passwordHash: schema.users.passwordHash,
      role: schema.users.role,
      emailVerifiedAt: schema.users.emailVerifiedAt,
      deletedAt: schema.users.deletedAt,
      mfaEnabled: schema.users.mfaEnabled,
      mfaSecretEncrypted: schema.users.mfaSecretEncrypted,
      mfaLastUsedStep: schema.users.mfaLastUsedStep,
    })
    .from(schema.users)
    .where(eq(schema.users.id, id))
    .limit(1);
  return row ?? null;
}

export interface AdminLockoutState {
  locked: boolean;
  unlockAt: Date | null;
}

/**
 * Admin lockout: count failed login_attempts for this email in the trailing
 * 30-minute window. Mirrors lib/lockout.ts but with the stricter admin window.
 * Both password failures and TOTP failures are recorded as failed attempts, so
 * they share the budget.
 */
export async function getAdminLockoutState(
  email: string,
): Promise<AdminLockoutState> {
  const db = getDb();
  const since = new Date(Date.now() - ADMIN_LOCKOUT_WINDOW_MS);
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
  const failures = Number(row?.failures ?? 0);
  if (failures < ADMIN_LOCKOUT_THRESHOLD) {
    return { locked: false, unlockAt: null };
  }
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
    ? new Date(oldest.attemptedAt.getTime() + ADMIN_LOCKOUT_WINDOW_MS)
    : new Date(Date.now() + ADMIN_LOCKOUT_WINDOW_MS);
  return { locked: true, unlockAt };
}

/**
 * Verify a 6-digit TOTP code against the admin's stored (encrypted) secret,
 * enforcing the replay guard. On success, persist the consumed step so the same
 * code cannot be redeemed again. Returns whether it matched.
 *
 * Fails closed on any crypto error (missing/garbled secret) — an admin whose
 * secret can't be decrypted cannot authenticate via TOTP and must use a
 * recovery code.
 */
export async function verifyAdminTotpCode(
  user: AdminRow,
  code: string,
  encKey: Buffer,
): Promise<boolean> {
  if (!user.mfaSecretEncrypted) return false;
  let secret: string;
  try {
    secret = decryptSecret(user.mfaSecretEncrypted, encKey);
  } catch {
    return false;
  }
  const result = verifyTotp(secret, code, { afterStep: user.mfaLastUsedStep });
  if (!result.valid || result.step === undefined) return false;
  // Persist the replay guard: record the consumed step so a later request that
  // re-presents this same code (step ≤ stored) is rejected by verifyTotp above.
  // This defeats sequential replay, the realistic threat for a single admin;
  // strict concurrent-use prevention would additionally gate success on the
  // UPDATE's row count, which is unnecessary at single-admin scale.
  await getDb()
    .update(schema.users)
    .set({ mfaLastUsedStep: result.step })
    .where(eq(schema.users.id, user.id));
  return true;
}

export interface RecoveryConsumeResult {
  ok: boolean;
  /** Unused recovery codes remaining after a successful consume. */
  remaining: number;
}

/**
 * Try to consume a recovery code: check the candidate against each unused
 * hashed code, and on the first match mark it used. Single-use by construction.
 */
export async function consumeRecoveryCode(
  userId: string,
  candidate: string,
): Promise<RecoveryConsumeResult> {
  const db = getDb();
  const rows = await db
    .select({
      id: schema.mfaRecoveryCodes.id,
      codeHash: schema.mfaRecoveryCodes.codeHash,
    })
    .from(schema.mfaRecoveryCodes)
    .where(
      and(
        eq(schema.mfaRecoveryCodes.userId, userId),
        isNull(schema.mfaRecoveryCodes.usedAt),
      ),
    );

  for (const row of rows) {
    // Sequential verify (Argon2id) — a handful of codes, off the hot path.
    if (await verifyRecoveryCode(row.codeHash, candidate)) {
      await db
        .update(schema.mfaRecoveryCodes)
        .set({ usedAt: new Date() })
        .where(eq(schema.mfaRecoveryCodes.id, row.id));
      const remaining = rows.length - 1;
      return { ok: true, remaining };
    }
  }
  return { ok: false, remaining: rows.length };
}

export interface PendingEnrolment {
  secretBase32: string;
  otpauthUri: string;
}

/**
 * Begin TOTP enrolment: mint a fresh secret, store it ENCRYPTED but leave
 * mfaEnabled=false (a half-finished enrolment must never gate login). Returns
 * the plaintext secret + otpauth URI for the authenticator app — shown once,
 * never persisted in plaintext.
 */
export async function beginEnrolment(
  user: AdminRow,
  keys: AdminKeys,
): Promise<PendingEnrolment> {
  const secretBase32 = generateTotpSecret();
  const encrypted = encryptSecret(secretBase32, keys.encKey);
  await getDb()
    .update(schema.users)
    .set({ mfaSecretEncrypted: encrypted })
    .where(eq(schema.users.id, user.id));
  return {
    secretBase32,
    otpauthUri: totpAuthUri({
      secretBase32,
      accountName: user.email,
      issuer: keys.issuer,
    }),
  };
}

/**
 * Finish enrolment: verify a code against the pending secret, and on success
 * flip mfaEnabled=true, stamp mfaEnrolledAt, seed the replay guard, and issue a
 * fresh set of recovery codes (replacing any prior set). Returns the plaintext
 * recovery codes (shown once) or null if the code didn't verify.
 */
export async function completeEnrolment(
  user: AdminRow,
  code: string,
  encKey: Buffer,
): Promise<string[] | null> {
  if (!user.mfaSecretEncrypted) return null;
  let secret: string;
  try {
    secret = decryptSecret(user.mfaSecretEncrypted, encKey);
  } catch {
    return null;
  }
  // No replay guard yet (first use) — afterStep null.
  const result = verifyTotp(secret, code, { afterStep: null });
  if (!result.valid || result.step === undefined) return null;

  const db = getDb();
  await db
    .update(schema.users)
    .set({
      mfaEnabled: true,
      mfaEnrolledAt: new Date(),
      mfaLastUsedStep: result.step,
    })
    .where(eq(schema.users.id, user.id));

  const codes = generateRecoveryCodes();
  const hashes = await Promise.all(codes.map((c) => hashRecoveryCode(c)));
  // Replace any previous set (re-enrolment invalidates old codes).
  await db
    .delete(schema.mfaRecoveryCodes)
    .where(eq(schema.mfaRecoveryCodes.userId, user.id));
  await db.insert(schema.mfaRecoveryCodes).values(
    hashes.map((codeHash) => ({ userId: user.id, codeHash })),
  );
  return codes;
}
