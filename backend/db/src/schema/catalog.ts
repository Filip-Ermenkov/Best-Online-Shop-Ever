import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { stockStatusEnum } from "./enums";

/**
 * Recursive category tree. parent_id NULL = top-level (root) category.
 * display_order is an integer — admins drag-and-drop in the panel; on every
 * reorder we rewrite the affected siblings' display_order in one transaction
 * (no fractional ordering — keeps it simple for a small catalog).
 *
 * Soft delete via deleted_at: when an admin deletes a category, all descendant
 * categories and products are also soft-deleted in the same transaction, and
 * a redirect row is written so old URLs 301 to the parent (or home for roots).
 */
export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    parentId: uuid("parent_id").references((): AnyPgColumn => categories.id, {
      onDelete: "restrict", // app deletes children explicitly; FK forbids orphan-by-DB
    }),
    imageS3Key: text("image_s3_key"),
    displayOrder: integer("display_order").notNull().default(0),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Slug is unique within a parent. Two categories with the same slug under
    // different parents are fine (e.g. /electronics/cases and /tools/cases).
    // Postgres UNIQUE treats NULLs as distinct — fine for top-level rows; we
    // enforce uniqueness of root slugs application-side.
    uniqueIndex("categories_parent_slug_unique").on(t.parentId, t.slug),
    index("categories_parent_id_idx").on(t.parentId),
    index("categories_deleted_at_idx").on(t.deletedAt),
  ],
);

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    code: text("code").notNull(), // human-facing SKU; unique
    name: text("name").notNull(),
    description: text("description").notNull().default(""),

    // Money: numeric(10,2) handles up to 99,999,999.99 EUR — plenty.
    // Always store as numeric/string in JS, never multiply through Number().
    priceCents: numeric("price_cents", { precision: 10, scale: 0 }).notNull(),
    currency: text("currency").notNull().default("EUR"),

    categoryId: uuid("category_id").references(() => categories.id, {
      onDelete: "restrict", // see categories — app handles cascade explicitly
    }),

    stockStatus: stockStatusEnum("stock_status").notNull().default("in_stock"),

    // The "NEW" badge shows until newUntil. Default = createdAt + 30 days,
    // set application-side at insert time.
    newUntil: timestamp("new_until", { withTimezone: true }),

    displayOrder: integer("display_order").notNull().default(0),

    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("products_code_unique").on(t.code),
    // Slug uniqueness: one product per slug across the whole shop. Simpler than
    // per-category uniqueness and matches the URL routing (/products/<slug>).
    uniqueIndex("products_slug_unique").on(t.slug),
    index("products_category_id_idx").on(t.categoryId),
    index("products_stock_status_idx").on(t.stockStatus),
    index("products_deleted_at_idx").on(t.deletedAt),
    // Order-by-display index for category listings.
    index("products_category_order_idx").on(t.categoryId, t.displayOrder),
    // CHECK: priceCents must be ≥ 0. The expression renders as a raw SQL
    // constraint and is generated into the migration verbatim.
    check("products_price_non_negative", sql`${t.priceCents} >= 0`),
  ],
);

/**
 * Product images. Order matters — admin drag-and-drops in the editor; the
 * lowest displayOrder is the "main" image used on cards/cart thumbnails.
 *
 * S3 key only; the public URL is derived at render time using the CloudFront
 * distribution URL from configuration. We never store fully-qualified URLs
 * because the CDN domain may change and the bucket might be private.
 */
export const productImages = pgTable(
  "product_images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    s3Key: text("s3_key").notNull(),
    altText: text("alt_text").notNull().default(""),
    displayOrder: integer("display_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("product_images_product_id_idx").on(t.productId, t.displayOrder),
  ],
);

/**
 * Promotional banner slides on the homepage. Multiple slides rotate; admin can
 * deactivate without deleting (isActive = false hides the slide everywhere).
 */
export const bannerSlides = pgTable(
  "banner_slides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    imageS3Key: text("image_s3_key").notNull(),
    title: text("title"),
    subtitle: text("subtitle"),
    linkUrl: text("link_url"),
    isActive: boolean("is_active").notNull().default(true),
    displayOrder: integer("display_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdate(() => new Date()),
  },
  (t) => [index("banner_slides_active_order_idx").on(t.isActive, t.displayOrder)],
);
