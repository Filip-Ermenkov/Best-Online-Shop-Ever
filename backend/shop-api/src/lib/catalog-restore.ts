/**
 * Pure helpers for restoring a catalog snapshot over the live catalog
 * (docs/README.md §12 „възстановяване до избрана версия"; roadmap item 52). No
 * DB, no S3, no Hono — the same pure/impure split as `category-tree.ts`,
 * `product-admin.ts`, and `order-status.ts`, so the diff logic and the snapshot
 * parser unit-test in isolation and could serve a future admin-api Lambda
 * unchanged. The route (`routes/admin/archive.ts`) owns the S3 read and the
 * transactional replay; everything decision-shaped lives here.
 *
 * A snapshot is the JSON envelope the catalog-backup job writes (jobs/
 * catalog-backup.ts): `{ v:1, kind:"catalog-backup", takenAt, counts, tables:{
 * categories, products, productImages, bannerSlides } }`, soft-deleted rows
 * INCLUDED (full fidelity — a restore must reproduce the `deleted_at` state too).
 *
 * Two jobs:
 *
 *   1. `parseCatalogSnapshot(raw)` — validate the S3 object and convert its
 *      JSON scalars (ISO strings, numeric-as-string) into DB-ready row shapes
 *      (real `Date`s), throwing `SnapshotFormatError` on anything malformed so
 *      the route can answer a clean 422 instead of a 500 mid-replay.
 *
 *   2. `planCatalogRestore(snapshot, live)` — the dry-run diff the preview
 *      endpoint returns and the confirm dialog renders. Its load-bearing job is
 *      to surface the DESTRUCTIVE part of a restore honestly: every row created
 *      AFTER the snapshot (i.e. live and not in the snapshot) will be archived
 *      by the replay, and the admin must see exactly which ones before typing
 *      the confirmation. This mirrors 2026 destructive-action guidance (preview
 *      the changes; the safety backup the route takes first is the "tail-log
 *      backup before restore" rule).
 *
 * Replay semantics the route implements against this data (documented here so
 * the contract lives with the diff):
 *
 *   - categories / products — UPSERT every snapshot row (restoring all columns,
 *     `deleted_at` included, so an accidental bulk edit or mass-delete is
 *     reverted); rows present live but ABSENT from the snapshot are SOFT-deleted
 *     (reversible, FK-safe), never hard-deleted. Because the catalog only ever
 *     soft-deletes, every historical row still exists, so the upsert is almost
 *     always an update — but the insert path is kept for a hand-deleted row.
 *   - product_images — replaced for each product IN the snapshot (scoped
 *     delete-then-insert); images of newer products are left untouched.
 *   - banner_slides — full replace (banners are presentation-only and already
 *     hard-delete by model; the pre-restore safety backup captures the old set).
 *
 * `orderCategoriesParentFirst` orders the category upserts so a (rare) genuinely
 * new row inserts after its parent — the self-referential FK is satisfied
 * without deferring constraints.
 */

import { z } from "zod";

// ─── Snapshot envelope validation ──────────────────────────────────────────────
//
// Rows arrive as parsed JSON: timestamps are ISO strings, `priceCents` (a
// Postgres numeric) is a string, booleans/integers are themselves. We validate
// leniently on unknown keys (default strip) so a future extra column never
// breaks an older restorer, but strictly on the columns the replay writes.

const IsoString = z.string().min(1);

const CategoryRowSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  parentId: z.string().uuid().nullable(),
  imageS3Key: z.string().nullable(),
  displayOrder: z.number().int(),
  deletedAt: IsoString.nullable(),
  createdAt: IsoString,
  updatedAt: IsoString,
});

const ProductRowSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  code: z.string(),
  name: z.string(),
  description: z.string(),
  // numeric(10,0) serialises as a string; keep it a string all the way to the
  // column (never Number() money).
  priceCents: z.string(),
  currency: z.string(),
  categoryId: z.string().uuid().nullable(),
  stockStatus: z.enum(["in_stock", "out_of_stock"]),
  newUntil: IsoString.nullable(),
  displayOrder: z.number().int(),
  deletedAt: IsoString.nullable(),
  createdAt: IsoString,
  updatedAt: IsoString,
});

const ProductImageRowSchema = z.object({
  id: z.string().uuid(),
  productId: z.string().uuid(),
  s3Key: z.string(),
  altText: z.string(),
  displayOrder: z.number().int(),
  createdAt: IsoString,
});

const BannerSlideRowSchema = z.object({
  id: z.string().uuid(),
  imageS3Key: z.string(),
  title: z.string().nullable(),
  subtitle: z.string().nullable(),
  linkUrl: z.string().nullable(),
  isActive: z.boolean(),
  displayOrder: z.number().int(),
  createdAt: IsoString,
  updatedAt: IsoString,
});

const RawCatalogSnapshotSchema = z.object({
  v: z.literal(1),
  kind: z.literal("catalog-backup"),
  takenAt: IsoString,
  tables: z.object({
    categories: z.array(CategoryRowSchema),
    products: z.array(ProductRowSchema),
    productImages: z.array(ProductImageRowSchema),
    bannerSlides: z.array(BannerSlideRowSchema),
  }),
});

/** Thrown when the S3 object is not a valid catalog snapshot → the route maps it to 422. */
export class SnapshotFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotFormatError";
  }
}

// ─── DB-ready row shapes (post-conversion: real Dates) ──────────────────────────

export interface CategorySnapshotRow {
  id: string;
  slug: string;
  name: string;
  parentId: string | null;
  imageS3Key: string | null;
  displayOrder: number;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProductSnapshotRow {
  id: string;
  slug: string;
  code: string;
  name: string;
  description: string;
  priceCents: string;
  currency: string;
  categoryId: string | null;
  stockStatus: "in_stock" | "out_of_stock";
  newUntil: Date | null;
  displayOrder: number;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProductImageSnapshotRow {
  id: string;
  productId: string;
  s3Key: string;
  altText: string;
  displayOrder: number;
  createdAt: Date;
}

export interface BannerSlideSnapshotRow {
  id: string;
  imageS3Key: string;
  title: string | null;
  subtitle: string | null;
  linkUrl: string | null;
  isActive: boolean;
  displayOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CatalogSnapshot {
  takenAt: string;
  categories: CategorySnapshotRow[];
  products: ProductSnapshotRow[];
  productImages: ProductImageSnapshotRow[];
  bannerSlides: BannerSlideSnapshotRow[];
}

/** ISO string → Date, throwing a SnapshotFormatError on an unparseable value. */
function toDate(iso: string, field: string): Date {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new SnapshotFormatError(`invalid timestamp in snapshot field "${field}": ${iso}`);
  }
  return d;
}

function toDateOrNull(iso: string | null, field: string): Date | null {
  return iso === null ? null : toDate(iso, field);
}

/**
 * Validate + normalise a parsed JSON value into a DB-ready `CatalogSnapshot`.
 * Throws `SnapshotFormatError` on a bad envelope or an unparseable timestamp.
 */
export function parseCatalogSnapshot(raw: unknown): CatalogSnapshot {
  const res = RawCatalogSnapshotSchema.safeParse(raw);
  if (!res.success) {
    throw new SnapshotFormatError(
      `not a valid catalog snapshot: ${res.error.issues[0]?.message ?? "unknown shape"}`,
    );
  }
  const { takenAt, tables } = res.data;
  return {
    takenAt,
    categories: tables.categories.map((c) => ({
      id: c.id,
      slug: c.slug,
      name: c.name,
      parentId: c.parentId,
      imageS3Key: c.imageS3Key,
      displayOrder: c.displayOrder,
      deletedAt: toDateOrNull(c.deletedAt, "categories.deletedAt"),
      createdAt: toDate(c.createdAt, "categories.createdAt"),
      updatedAt: toDate(c.updatedAt, "categories.updatedAt"),
    })),
    products: tables.products.map((p) => ({
      id: p.id,
      slug: p.slug,
      code: p.code,
      name: p.name,
      description: p.description,
      priceCents: p.priceCents,
      currency: p.currency,
      categoryId: p.categoryId,
      stockStatus: p.stockStatus,
      newUntil: toDateOrNull(p.newUntil, "products.newUntil"),
      displayOrder: p.displayOrder,
      deletedAt: toDateOrNull(p.deletedAt, "products.deletedAt"),
      createdAt: toDate(p.createdAt, "products.createdAt"),
      updatedAt: toDate(p.updatedAt, "products.updatedAt"),
    })),
    productImages: tables.productImages.map((i) => ({
      id: i.id,
      productId: i.productId,
      s3Key: i.s3Key,
      altText: i.altText,
      displayOrder: i.displayOrder,
      createdAt: toDate(i.createdAt, "productImages.createdAt"),
    })),
    bannerSlides: tables.bannerSlides.map((b) => ({
      id: b.id,
      imageS3Key: b.imageS3Key,
      title: b.title,
      subtitle: b.subtitle,
      linkUrl: b.linkUrl,
      isActive: b.isActive,
      displayOrder: b.displayOrder,
      createdAt: toDate(b.createdAt, "bannerSlides.createdAt"),
      updatedAt: toDate(b.updatedAt, "bannerSlides.updatedAt"),
    })),
  };
}

// ─── The dry-run diff (preview) ────────────────────────────────────────────────

/** Minimal live-catalog projection the diff needs. */
export interface LiveCatalogState {
  categories: { id: string; name: string; deletedAt: Date | null }[];
  products: { id: string; name: string; deletedAt: Date | null }[];
  /** Count of banner rows currently in the table (the full-replace drops them). */
  bannerCount: number;
}

/** Names of at most this many soon-to-be-archived rows travel in the preview. */
export const ARCHIVE_SAMPLE_CAP = 25;

export interface CatalogRestorePlan {
  /** When the snapshot was taken (its `takenAt`). */
  takenAt: string;
  /** Row counts the snapshot will bring the catalog back to. */
  counts: {
    categories: number;
    products: number;
    productImages: number;
    bannerSlides: number;
  };
  /**
   * The destructive part: rows that are LIVE now but absent from the snapshot
   * (created after it) — the replay soft-deletes these. Counts are exact; the
   * name lists are capped at `ARCHIVE_SAMPLE_CAP` for the preview.
   */
  willArchive: {
    productCount: number;
    categoryCount: number;
    productNames: string[];
    categoryNames: string[];
  };
  /** Live banner rows the full-replace will drop before re-inserting the snapshot's. */
  liveBannerCount: number;
}

/**
 * Compute what restoring `snapshot` over `live` would do. Pure — the route
 * feeds it a live projection and returns the result verbatim from the preview
 * endpoint (and echoes it from the restore endpoint as "what was applied").
 *
 * "Will archive" counts only rows that are currently LIVE (`deletedAt === null`)
 * and not in the snapshot: an already-archived newer row would be a no-op, so it
 * is not reported as a change.
 */
export function planCatalogRestore(
  snapshot: CatalogSnapshot,
  live: LiveCatalogState,
): CatalogRestorePlan {
  const snapCategoryIds = new Set(snapshot.categories.map((c) => c.id));
  const snapProductIds = new Set(snapshot.products.map((p) => p.id));

  const archivedCategories = live.categories.filter(
    (c) => c.deletedAt === null && !snapCategoryIds.has(c.id),
  );
  const archivedProducts = live.products.filter(
    (p) => p.deletedAt === null && !snapProductIds.has(p.id),
  );

  return {
    takenAt: snapshot.takenAt,
    counts: {
      categories: snapshot.categories.length,
      products: snapshot.products.length,
      productImages: snapshot.productImages.length,
      bannerSlides: snapshot.bannerSlides.length,
    },
    willArchive: {
      productCount: archivedProducts.length,
      categoryCount: archivedCategories.length,
      productNames: archivedProducts.slice(0, ARCHIVE_SAMPLE_CAP).map((p) => p.name),
      categoryNames: archivedCategories.slice(0, ARCHIVE_SAMPLE_CAP).map((c) => c.name),
    },
    liveBannerCount: live.bannerCount,
  };
}

// ─── FK-safe category ordering ─────────────────────────────────────────────────

/**
 * Order categories so every row appears AFTER its parent — the order a per-row
 * upsert must follow so a genuinely new child never inserts before its (also
 * new) parent and trips the self-referential FK. A parent outside the set, or a
 * malformed cycle, degrades to "place where reached" rather than looping.
 */
export function orderCategoriesParentFirst<T extends { id: string; parentId: string | null }>(
  rows: T[],
): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const placed = new Set<string>();
  const out: T[] = [];

  const visit = (row: T, stack: Set<string>): void => {
    if (placed.has(row.id) || stack.has(row.id)) return;
    stack.add(row.id);
    if (row.parentId !== null) {
      const parent = byId.get(row.parentId);
      if (parent) visit(parent, stack);
    }
    stack.delete(row.id);
    placed.add(row.id);
    out.push(row);
  };

  for (const row of rows) visit(row, new Set());
  return out;
}
