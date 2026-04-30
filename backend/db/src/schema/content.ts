import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { categories, products } from "./catalog";
import { redirectTargetKindEnum } from "./enums";
import { users } from "./users";

/**
 * Versioned Terms of Service.
 *
 * The admin can either save a "draft edit" (no new version — typo fix etc.) or
 * publish a new version. When a new version is published, every existing
 * customer must accept it before they can place orders again (modal at next
 * login per README §9).
 *
 * `version_number` is monotonic — strictly increasing integer assigned by the
 * publish action. The publish-time content is captured in `content_md` and is
 * NEVER edited after publish — that's the legal record.
 */
export const tosVersions = pgTable(
  "tos_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    versionNumber: integer("version_number").notNull(),
    contentMd: text("content_md").notNull(),
    publishedByUserId: uuid("published_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    publishedAt: timestamp("published_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [uniqueIndex("tos_versions_version_number_unique").on(t.versionNumber)],
);

/** Per-user record of which ToS versions they have accepted. */
export const tosAcceptances = pgTable(
  "tos_acceptances",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tosVersionId: uuid("tos_version_id")
      .notNull()
      .references(() => tosVersions.id, { onDelete: "cascade" }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [primaryKey({ columns: [t.userId, t.tosVersionId] })],
);

/**
 * Privacy policy — single live document, no version-acceptance modal because
 * the doc is informational. Edit history kept by separate table (or via an
 * audit log table — for now overwriting with `updated_at` tracking is fine).
 */
export const privacyPolicy = pgTable("privacy_policy", {
  id: uuid("id").primaryKey().defaultRandom(),
  contentMd: text("content_md").notNull(),
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`)
    .$onUpdate(() => new Date()),
});

/**
 * Key-value settings table. Stores all the configurable values from README §9
 * "Настройки на магазина" (store address, hours, contact phone/email,
 * default pickup deadline days, etc.). JSON-typed value keeps the table
 * generic.
 *
 * Examples:
 *   ('default_pickup_deadline_days', '7')
 *   ('store_address', '"ул. Витоша 15, София 1000"')
 *   ('store_hours', '{"mon_fri": "9:00-18:00", "sat": "10:00-14:00", "sun": "closed"}')
 */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`)
    .$onUpdate(() => new Date()),
});

/**
 * 301 redirect table. When a category or product is deleted, we write a row
 * here pointing the old URL to the appropriate target (parent category for a
 * deleted subcategory, parent category for a deleted product, home for a
 * deleted root category). The Next.js middleware reads this on every request
 * (with caching) before serving 404.
 *
 * `source_path` is the *full* deleted URL, e.g. /products/electronics/old-phone.
 * Either category_id or product_id may be set for context but isn't required —
 * target_kind drives the redirect logic.
 */
export const redirects = pgTable(
  "redirects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourcePath: text("source_path").notNull(),
    targetKind: redirectTargetKindEnum("target_kind").notNull(),
    /** When target is a surviving category, the new URL's category. */
    targetCategoryId: uuid("target_category_id").references(() => categories.id, {
      onDelete: "set null",
    }),
    /** Reserved for product-aliasing in the future. */
    targetProductId: uuid("target_product_id").references(() => products.id, {
      onDelete: "set null",
    }),
    /** HTTP status — almost always 301. 302/307 reserved for short-term moves. */
    statusCode: integer("status_code").notNull().default(301),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [uniqueIndex("redirects_source_path_unique").on(t.sourcePath)],
);
