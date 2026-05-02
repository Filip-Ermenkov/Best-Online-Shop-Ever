import { generateSessionToken, hashSessionToken } from "@shop/auth";
import { schema } from "@shop/db";
import { and, count, eq, gt, lt, ne } from "drizzle-orm";
import { getDb } from "./db.js";

/**
 * Session lifecycle. Pure DB plumbing — the route layer composes these calls
 * with cookie setting and lockout state.
 *
 * Invariants:
 *   - The plaintext token is returned ONLY from createSession(). After that
 *     it lives exclusively in the user's cookie. Every other call site
 *     accepts a token (the cookie value) and immediately hashes it before
 *     touching the DB.
 *   - sessions.id_hash is the SHA-256 hex of the token (see @shop/auth/
 *     session-tokens.ts for why SHA-256 and not Argon2id).
 *   - validateSession returns null for any of: missing, expired, user gone.
 *     Callers MUST treat null as "anonymous" — never log the rejected token.
 */

/** Idle timeout for non-rememberMe sessions: 2 hours, per spec README §8. */
const IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** Absolute lifetime for rememberMe sessions: 30 days, per spec README §8. */
const REMEMBER_ME_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

export type UserRole = "admin" | "customer";
export type AccountType = "personal" | "corporate";

export interface CreateSessionInput {
  userId: string;
  rememberMe: boolean;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface CreatedSession {
  /** Plaintext token to put in the cookie. Returned ONCE — never persisted. */
  token: string;
  expiresAt: Date;
}

export async function createSession(
  input: CreateSessionInput,
): Promise<CreatedSession> {
  const db = getDb();
  const token = generateSessionToken();
  const idHash = hashSessionToken(token);
  const expiresAt = computeExpiresAt(input.rememberMe);

  await db.insert(schema.sessions).values({
    idHash,
    userId: input.userId,
    rememberMe: input.rememberMe,
    expiresAt,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  });

  return { token, expiresAt };
}

export interface SessionAndUser {
  session: {
    idHash: string;
    userId: string;
    rememberMe: boolean;
    expiresAt: Date;
  };
  user: {
    id: string;
    email: string;
    role: UserRole;
    /** Null only for admin users (account_type column is nullable for them). */
    accountType: AccountType | null;
    emailVerifiedAt: Date | null;
  };
}

/**
 * The active session for a token, plus its user. Null if the token is
 * unknown, expired, or the user has been deleted.
 *
 * Side effect on the happy path: refresh `expiresAt` and `lastActiveAt`.
 *
 *   - For non-rememberMe: rolls the 2h idle window forward from now.
 *   - For rememberMe: rolls the 30d absolute window forward from now.
 *     (Spec calls this "Периодът се подновява при всяко активно посещение".)
 *
 * We refresh on every read for now. If this becomes a write hotspot at
 * scale, the standard fix is "only refresh if more than N minutes have
 * passed since lastActiveAt" — additive change, no schema impact.
 */
export async function validateSession(
  token: string,
): Promise<SessionAndUser | null> {
  const db = getDb();
  const idHash = hashSessionToken(token);
  const now = new Date();

  const rows = await db
    .select({
      idHash: schema.sessions.idHash,
      userId: schema.sessions.userId,
      rememberMe: schema.sessions.rememberMe,
      expiresAt: schema.sessions.expiresAt,
      userEmail: schema.users.email,
      userRole: schema.users.role,
      userAccountType: schema.users.accountType,
      userEmailVerifiedAt: schema.users.emailVerifiedAt,
      userDeletedAt: schema.users.deletedAt,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(
      and(
        eq(schema.sessions.idHash, idHash),
        gt(schema.sessions.expiresAt, now),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.userDeletedAt !== null) {
    await db.delete(schema.sessions).where(eq(schema.sessions.idHash, idHash));
    return null;
  }

  const newExpiresAt = computeExpiresAt(row.rememberMe);
  await db
    .update(schema.sessions)
    .set({ expiresAt: newExpiresAt, lastActiveAt: now })
    .where(eq(schema.sessions.idHash, idHash));

  return {
    session: {
      idHash: row.idHash,
      userId: row.userId,
      rememberMe: row.rememberMe,
      expiresAt: newExpiresAt,
    },
    user: {
      id: row.userId,
      email: row.userEmail,
      role: row.userRole,
      accountType: row.userAccountType,
      emailVerifiedAt: row.userEmailVerifiedAt,
    },
  };
}

/**
 * Logout: drop a single session. Idempotent — deleting a session that
 * doesn't exist is a no-op (the cookie was already invalid).
 */
export async function deleteSession(token: string): Promise<void> {
  const db = getDb();
  const idHash = hashSessionToken(token);
  await db.delete(schema.sessions).where(eq(schema.sessions.idHash, idHash));
}

/**
 * "Sign out everywhere" — used by password-change and account-deletion
 * flows. `keepIdHash` lets the caller preserve their own session (per spec
 * §8: the device that initiated a password change does NOT get logged out
 * of itself).
 */
export async function deleteAllSessionsForUser(
  userId: string,
  keepIdHash?: string,
): Promise<void> {
  const db = getDb();
  const where = keepIdHash
    ? and(
        eq(schema.sessions.userId, userId),
        ne(schema.sessions.idHash, keepIdHash),
      )
    : eq(schema.sessions.userId, userId);
  await db.delete(schema.sessions).where(where);
}

/**
 * Periodic cleanup hook: remove expired sessions.
 *
 * Not on a hot path — call it from a scheduled job (EventBridge -> mainten-
 * ance Lambda). The drizzle DbClient is a union of node-pg and neon-http
 * drivers that disagree on .returning() typing for delete; we sidestep
 * that by doing a count + delete in two cheap calls.
 */
export async function purgeExpiredSessions(): Promise<number> {
  const db = getDb();
  const now = new Date();
  const rows = await db
    .select({ n: count() })
    .from(schema.sessions)
    .where(lt(schema.sessions.expiresAt, now));
  const n = rows[0]?.n ?? 0;
  await db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, now));
  return Number(n);
}

function computeExpiresAt(rememberMe: boolean): Date {
  return new Date(
    Date.now() + (rememberMe ? REMEMBER_ME_LIFETIME_MS : IDLE_TIMEOUT_MS),
  );
}
