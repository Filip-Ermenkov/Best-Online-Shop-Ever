import { sql } from "drizzle-orm";
import {
  index,
  inet,
  jsonb,
  pgTable,
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
