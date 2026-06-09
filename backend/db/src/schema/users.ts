import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { accountTypeEnum, userRoleEnum } from "./enums";

/**
 * Single users table for both admins and customers. role and account_type
 * govern which side-tables are populated:
 *
 *   role=admin     → no profile row required, uses mfa_* fields
 *   role=customer  → exactly one of customer_profiles or corporate_profiles
 *                    based on account_type
 *
 * Soft delete: deleted_at marks an account scheduled for deletion. After GDPR
 * anonymization (anonymized_at), email is rewritten to "deleted-<uuid>@local"
 * so the email unique index still holds, but no PII remains. Order history
 * (which carries snapshots of customer details) is unaffected.
 *
 * email_verified_at: NULL means the user can browse but cannot place orders.
 * See README §8.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: userRoleEnum("role").notNull(),
    accountType: accountTypeEnum("account_type"), // null for admin

    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),

    // Brute-force protection (see README §8 — 5 fails → 15-min lockout for customer,
    // 30-min for admin). Lambda increments failedLoginCount; transitions to
    // lockedUntil are atomic via UPDATE … WHERE version = ?.
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),

    // MFA — required for admin, optional but recommended for customers (future).
    // mfaSecretEncrypted is encrypted with the application key (never plaintext at rest).
    // Even if the DB is dumped, the secret cannot generate codes without the app key.
    // Concretely AES-256-GCM via @shop/auth mfa-crypto.ts; the key lives in SSM,
    // never in this table. mfaEnabled flips true only after the enrolling device
    // proves one TOTP code (so a half-finished enrolment can't gate login).
    mfaEnabled: boolean("mfa_enabled").notNull().default(false),
    mfaSecretEncrypted: text("mfa_secret_encrypted"),
    // Replay guard (RFC 6238 single-use within the skew window). The last TOTP
    // time-step counter successfully consumed; verification rejects any code at
    // a step ≤ this, so a code can be redeemed at most once even inside its 30s
    // validity window. bigint (mode:number) — a 30s step index stays well within
    // JS safe-integer range for millennia. Null until the first successful MFA.
    mfaLastUsedStep: bigint("mfa_last_used_step", { mode: "number" }),
    // When TOTP enrolment was confirmed (the moment mfaEnabled went true). Drives
    // the audit trail and any "your MFA was changed" out-of-band notice.
    mfaEnrolledAt: timestamp("mfa_enrolled_at", { withTimezone: true }),

    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    anonymizedAt: timestamp("anonymized_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Email is globally unique. Lower-cased application-side before insert/select
    // — we enforce uniqueness on the literal value to keep the index simple,
    // but the API layer must normalise.
    uniqueIndex("users_email_unique").on(t.email),
    index("users_role_idx").on(t.role),
    index("users_deleted_at_idx").on(t.deletedAt),
  ],
);

/**
 * Personal-account profile. Joined 1:1 with users where account_type='personal'.
 * Separate table (not nullable columns on users) so corporate fields don't litter
 * the personal-customer rows and vice versa.
 */
export const customerProfiles = pgTable("customer_profiles", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  fullName: text("full_name").notNull(),
  phone: text("phone").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`)
    .$onUpdate(() => new Date()),
});

/**
 * Corporate-account profile. EIK and VAT number formats are validated in the API
 * layer (Zod schema in @shop/shared); the DB only enforces presence + uniqueness
 * where applicable.
 */
export const corporateProfiles = pgTable(
  "corporate_profiles",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    companyName: text("company_name").notNull(),
    eik: text("eik").notNull(), // Bulstat (БУЛСТАТ / ЕИК)
    vatNumber: text("vat_number"), // Optional — only VAT-registered companies have one
    registeredAddress: text("registered_address").notNull(),
    mol: text("mol").notNull(), // Материалноотговорно лице
    contactName: text("contact_name").notNull(),
    contactPhone: text("contact_phone").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // EIK is per-company — multiple users with the same company would share it,
    // but the spec describes one corporate account per company in practice.
    // Enforce uniqueness; relax only if the spec changes.
    uniqueIndex("corporate_profiles_eik_unique").on(t.eik),
  ],
);

/**
 * Customer address book. No "default address" concept by spec — customer always
 * picks explicitly at checkout (README §6).
 */
export const addresses = pgTable(
  "addresses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: text("label"), // Optional user-given nickname e.g. "Office"
    city: text("city").notNull(),
    postalCode: text("postal_code").notNull(),
    street: text("street").notNull(),
    apartmentOrOffice: text("apartment_or_office"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index("addresses_user_id_idx").on(t.userId)],
);

/**
 * Per-account percentage discount (admin-set). At most one row per user.
 * Lifted out of users to avoid bloating the auth-hot table and to keep the
 * audit trail (applied_by, applied_at) tidy.
 */
export const discounts = pgTable("discounts", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  // 0–100 — application-side validates; DB enforces via CHECK.
  percent: numeric("percent", { precision: 5, scale: 2 }).notNull(),
  appliedByUserId: uuid("applied_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  appliedAt: timestamp("applied_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

/**
 * Admin MFA recovery codes. Each row is one single-use code. Hashed at rest
 * (Argon2id) — even with DB access, codes cannot be enumerated.
 */
export const mfaRecoveryCodes = pgTable(
  "mfa_recovery_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index("mfa_recovery_codes_user_id_idx").on(t.userId)],
);
