import { sql } from "drizzle-orm";
import {
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { catalogBackupKindEnum, cookieConsentCategoryEnum } from "./enums";
import { users } from "./users";

/**
 * Catalog backups taken to S3 — one row per snapshot. The `s3_key` points at
 * a JSON dump (categories + products + images metadata) versioned by S3 native
 * versioning. Daily auto-backup runs at 03:00 (EventBridge → scheduler Lambda);
 * admin can also trigger manual ones.
 *
 * Restoring is an admin action that reads the s3 object back and replays it
 * into the catalog tables; orders are NOT touched (they have their own
 * snapshot in order_items).
 */
export const catalogBackups = pgTable(
  "catalog_backups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    s3Key: text("s3_key").notNull(),
    kind: catalogBackupKindEnum("kind").notNull(),
    triggeredByUserId: uuid("triggered_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    sizeBytes: text("size_bytes"), // text, not integer — JS numbers can't hold > 2^53 cleanly
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index("catalog_backups_created_at_idx").on(t.createdAt)],
);

/**
 * Admin audit log — append-only record of every state-changing admin action.
 * Required for incident investigation, compliance, and to honour GDPR Art. 30
 * "records of processing activities".
 *
 * `entity_table` + `entity_id` identify what was touched; `changes` captures
 * the diff (preferably {before, after} or a JSON Patch). The application is
 * responsible for redacting password hashes and other secrets BEFORE logging.
 */
export const adminAuditLog = pgTable(
  "admin_audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(), // e.g. "order.cancel", "product.delete"
    entityTable: text("entity_table"),
    entityId: text("entity_id"), // text, not uuid — accommodates settings.key etc.
    changes: jsonb("changes"), // before/after diff
    ipAddress: inet("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("admin_audit_log_actor_idx").on(t.actorUserId, t.createdAt),
    index("admin_audit_log_entity_idx").on(t.entityTable, t.entityId),
    index("admin_audit_log_created_at_idx").on(t.createdAt),
  ],
);

/**
 * Cookie-consent log — auditable per-visitor record of which categories were
 * accepted, when, from what IP/UA. Required by Bulgarian DPA and CNIL-style
 * regulators to demonstrate "consent was freely given and recorded".
 *
 * `visitor_id` is an opaque ID set in a first-party essential cookie (no PII)
 * — a single browser session/device. NOT linked to user accounts here; the
 * link, if any, lives in the application layer.
 *
 * Categories use the enum array form because there are only two opt-in
 * categories (analytics, marketing); essentials are always-on and not stored.
 */
export const cookieConsents = pgTable(
  "cookie_consents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    visitorId: text("visitor_id").notNull(),
    acceptedCategories: cookieConsentCategoryEnum("accepted_categories").array().notNull(),
    ipAddress: inet("ip_address"),
    userAgent: text("user_agent"),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("cookie_consents_visitor_idx").on(t.visitorId, t.recordedAt),
  ],
);

/**
 * Distributed rate-limit counters — one row per (bucket, subject, window).
 *
 * This is the shared-state backing store for the application-level rate
 * limiters on the PUBLIC, unauthenticated surface (guest order placement and
 * the lost-tracking-link resend). On Lambda each warm container has its own
 * memory, so a purely in-memory limiter is per-container: the effective ceiling
 * silently multiplies by the number of warm containers and resets on every cold
 * start. Keeping the counter in Postgres — the one piece of state every
 * container already shares — makes the limit hold cluster-wide, exactly the way
 * the DB-backed login lockout (`login_attempts`) and the scheduler claim markers
 * already do. No new infrastructure, no DynamoDB, no Redis (see ARCHITECTURE §13).
 *
 * Design:
 *   - `bucket`       — limiter namespace, e.g. "guest_find" / "guest_place".
 *   - `subject`      — the throttle key within the bucket (e.g. the client IP).
 *   - `window_start` — start of a fixed (tumbling) window, computed app-side as
 *                      floor(now / windowMs) * windowMs. Because it is part of
 *                      the primary key, a new window is simply a new row that
 *                      starts again at count = 1 — no reset/CASE logic needed.
 *   - `count`        — hits recorded in that window.
 *
 * The composite primary key is what makes the increment atomic: a single
 * `INSERT … ON CONFLICT (pk) DO UPDATE SET count = count + 1 … RETURNING count`
 * serialises concurrent writers on the row lock with no lost updates and no
 * advisory lock (see `@shop/api` lib/rate-limit-db.ts). Aged-out rows are pruned
 * by the daily retention sweep (`@shop/api` jobs/unverified-cleanup.ts), so the
 * table stays tiny. No FK / PII: `subject` is an opaque key (an IP at most), and
 * losing a row only ever GRANTS allowance — the fail-open bias right for an
 * abuse dampener on a public endpoint.
 */
export const rateLimitCounters = pgTable(
  "rate_limit_counters",
  {
    bucket: text("bucket").notNull(),
    subject: text("subject").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.bucket, t.subject, t.windowStart] }),
    index("rate_limit_counters_window_idx").on(t.windowStart),
  ],
);
