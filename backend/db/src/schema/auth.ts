import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  inet,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { verificationTokenKindEnum } from "./enums";
import { users } from "./users";

/**
 * Server-side sessions. The cookie carries `id` (cryptographically random),
 * never a JWT — that way a single DELETE invalidates a session immediately
 * across all devices when the user changes their password.
 *
 * `remember_me` differentiates the two modes from README §8:
 *  - rememberMe = false → expiresAt rolls forward on activity, max 2 hours idle
 *  - rememberMe = true  → expiresAt is 30 days from creation/refresh
 *
 * The session ID is hashed (Argon2id, fast params) before storage so even with
 * a DB dump an attacker cannot use the IDs to impersonate.
 */
export const sessions = pgTable(
  "sessions",
  {
    /** Hashed session token. The plaintext lives only in the user's cookie. */
    idHash: text("id_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    rememberMe: boolean("remember_me").notNull().default(false),
    ipAddress: inet("ip_address"),
    userAgent: text("user_agent"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("sessions_user_id_idx").on(t.userId),
    index("sessions_expires_at_idx").on(t.expiresAt),
  ],
);

/**
 * Email verification tokens — used both for initial signup and for confirming
 * an email-address change. `kind` distinguishes them so the same table serves
 * both flows.
 *
 * Token plaintext lives only in the email link; we store a hash. Single-use:
 * `consumed_at` is set on first use; subsequent uses are rejected.
 */
export const emailVerificationTokens = pgTable(
  "email_verification_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: verificationTokenKindEnum("kind").notNull(),
    /**
     * For email-change tokens, the new address being verified. NULL for signup
     * tokens (the address is on the users row).
     */
    newEmail: text("new_email"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("email_verification_tokens_user_idx").on(t.userId),
    index("email_verification_tokens_expires_idx").on(t.expiresAt),
  ],
);

/**
 * Password reset tokens. 1-hour validity for customers, 15 minutes for admins
 * (enforced application-side via `expires_at`). Single-use; consumed atomically
 * with the password update.
 */
export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("password_reset_tokens_user_idx").on(t.userId),
    index("password_reset_tokens_expires_idx").on(t.expiresAt),
  ],
);

/**
 * Login-attempt audit log. Every authentication attempt — successful OR failed,
 * for customer OR admin — appends a row. Powers:
 *   - Brute-force lockout (count failures within time window)
 *   - Admin security review (suspicious IP patterns)
 *   - GDPR access-log requirement (Art. 30 records)
 *
 * Retention: 180 days (cleaned by a scheduled task — implemented in a later slice).
 */
export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * The email entered. May not match a real user (typos, attempts on non-
     * existent accounts) — we still record it for pattern detection.
     */
    email: text("email").notNull(),
    success: boolean("success").notNull(),
    ipAddress: inet("ip_address"),
    userAgent: text("user_agent"),
    attemptedAt: timestamp("attempted_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("login_attempts_email_time_idx").on(t.email, t.attemptedAt),
    index("login_attempts_ip_time_idx").on(t.ipAddress, t.attemptedAt),
  ],
);
