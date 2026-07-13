import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ARCHIVE_SAMPLE_CAP,
  orderCategoriesParentFirst,
  parseCatalogSnapshot,
  planCatalogRestore,
  SnapshotFormatError,
  type CatalogSnapshot,
  type LiveCatalogState,
} from "../../src/lib/catalog-restore.js";

/**
 * Pure-helper tests for the snapshot-restore library (roadmap item 52):
 *   - `parseCatalogSnapshot` validates the S3 envelope and converts JSON scalars
 *     to DB-ready Dates, throwing `SnapshotFormatError` on anything malformed.
 *   - `planCatalogRestore` computes the dry-run diff — above all the destructive
 *     "rows created after the snapshot get archived" set.
 *   - `orderCategoriesParentFirst` yields an FK-safe upsert order.
 * DB-free, like category-tree/product-admin/error-response.
 */

const T = "2026-06-01T00:00:00.000Z";

function rawCat(o: {
  id: string;
  slug?: string;
  name?: string;
  parentId?: string | null;
  deletedAt?: string | null;
}) {
  return {
    id: o.id,
    slug: o.slug ?? "c",
    name: o.name ?? "C",
    parentId: o.parentId ?? null,
    imageS3Key: null,
    displayOrder: 0,
    deletedAt: o.deletedAt ?? null,
    createdAt: T,
    updatedAt: T,
  };
}

function rawProd(o: {
  id: string;
  slug?: string;
  code?: string;
  name?: string;
  categoryId?: string | null;
  deletedAt?: string | null;
}) {
  return {
    id: o.id,
    slug: o.slug ?? "p",
    code: o.code ?? "P",
    name: o.name ?? "P",
    description: "",
    priceCents: "1999",
    currency: "EUR",
    categoryId: o.categoryId ?? null,
    stockStatus: "in_stock" as const,
    newUntil: null,
    displayOrder: 0,
    deletedAt: o.deletedAt ?? null,
    createdAt: T,
    updatedAt: T,
  };
}

function envelope(tables: {
  categories?: ReturnType<typeof rawCat>[];
  products?: ReturnType<typeof rawProd>[];
  productImages?: unknown[];
  bannerSlides?: unknown[];
}): unknown {
  const t = {
    categories: tables.categories ?? [],
    products: tables.products ?? [],
    productImages: tables.productImages ?? [],
    bannerSlides: tables.bannerSlides ?? [],
  };
  return {
    v: 1,
    kind: "catalog-backup",
    takenAt: T,
    counts: {
      categories: t.categories.length,
      products: t.products.length,
      productImages: t.productImages.length,
      bannerSlides: t.bannerSlides.length,
    },
    tables: t,
  };
}

describe("parseCatalogSnapshot", () => {
  it("parses a valid envelope and converts timestamps to Dates", () => {
    const catId = randomUUID();
    const snap = parseCatalogSnapshot(
      envelope({
        categories: [rawCat({ id: catId, slug: "obuvki", name: "Обувки" })],
        products: [
          rawProd({ id: randomUUID(), categoryId: catId, deletedAt: T }),
        ],
      }),
    );
    expect(snap.takenAt).toBe(T);
    expect(snap.categories).toHaveLength(1);
    expect(snap.categories[0]!.createdAt).toBeInstanceOf(Date);
    expect(snap.products[0]!.deletedAt).toBeInstanceOf(Date);
    expect(snap.products[0]!.priceCents).toBe("1999"); // money stays a string
  });

  it("accepts (and strips) unknown extra columns for forward-compat", () => {
    const raw = envelope({ categories: [rawCat({ id: randomUUID() })] }) as {
      tables: { categories: Record<string, unknown>[] };
    };
    raw.tables.categories[0]!.futureColumn = "ignored";
    expect(() => parseCatalogSnapshot(raw)).not.toThrow();
  });

  it("rejects a non-catalog-backup envelope", () => {
    expect(() => parseCatalogSnapshot({ v: 1, kind: "something-else", tables: {} })).toThrow(
      SnapshotFormatError,
    );
    expect(() => parseCatalogSnapshot({ hello: "world" })).toThrow(SnapshotFormatError);
  });

  it("rejects a row with an unparseable timestamp", () => {
    const bad = envelope({ categories: [rawCat({ id: randomUUID() })] }) as {
      tables: { categories: { createdAt: string }[] };
    };
    bad.tables.categories[0]!.createdAt = "not-a-date";
    expect(() => parseCatalogSnapshot(bad)).toThrow(SnapshotFormatError);
  });
});

describe("planCatalogRestore", () => {
  function snapshotOf(
    categories: ReturnType<typeof rawCat>[],
    products: ReturnType<typeof rawProd>[],
  ): CatalogSnapshot {
    return parseCatalogSnapshot(envelope({ categories, products }));
  }

  it("counts snapshot rows and flags only live rows absent from the snapshot", () => {
    const keptCat = randomUUID();
    const keptProd = randomUUID();
    const newerProd = randomUUID();
    const newerCat = randomUUID();
    const alreadyArchived = randomUUID();

    const snapshot = snapshotOf(
      [rawCat({ id: keptCat, slug: "c-keep" })],
      [rawProd({ id: keptProd, slug: "p-keep", code: "K" })],
    );

    const live: LiveCatalogState = {
      categories: [
        { id: keptCat, name: "Keep", deletedAt: null },
        { id: newerCat, name: "New Category", deletedAt: null }, // will archive
      ],
      products: [
        { id: keptProd, name: "Keep", deletedAt: null },
        { id: newerProd, name: "New Product", deletedAt: null }, // will archive
        { id: alreadyArchived, name: "Old", deletedAt: new Date() }, // no-op (already gone)
      ],
      bannerCount: 3,
    };

    const plan = planCatalogRestore(snapshot, live);
    expect(plan.counts).toEqual({
      categories: 1,
      products: 1,
      productImages: 0,
      bannerSlides: 0,
    });
    expect(plan.willArchive.productCount).toBe(1);
    expect(plan.willArchive.categoryCount).toBe(1);
    expect(plan.willArchive.productNames).toEqual(["New Product"]);
    expect(plan.willArchive.categoryNames).toEqual(["New Category"]);
    expect(plan.liveBannerCount).toBe(3);
  });

  it("archives every live row when the snapshot is empty", () => {
    const snapshot = snapshotOf([], []);
    const live: LiveCatalogState = {
      categories: [{ id: randomUUID(), name: "C", deletedAt: null }],
      products: [
        { id: randomUUID(), name: "P1", deletedAt: null },
        { id: randomUUID(), name: "P2", deletedAt: null },
      ],
      bannerCount: 0,
    };
    const plan = planCatalogRestore(snapshot, live);
    expect(plan.willArchive.categoryCount).toBe(1);
    expect(plan.willArchive.productCount).toBe(2);
  });

  it("caps the name samples but keeps exact counts", () => {
    const snapshot = snapshotOf([], []);
    const products = Array.from({ length: ARCHIVE_SAMPLE_CAP + 5 }, (_, i) => ({
      id: randomUUID(),
      name: `P${i}`,
      deletedAt: null,
    }));
    const plan = planCatalogRestore(snapshot, {
      categories: [],
      products,
      bannerCount: 0,
    });
    expect(plan.willArchive.productCount).toBe(ARCHIVE_SAMPLE_CAP + 5);
    expect(plan.willArchive.productNames).toHaveLength(ARCHIVE_SAMPLE_CAP);
  });
});

describe("orderCategoriesParentFirst", () => {
  it("places every parent before its children", () => {
    const root = { id: "r", parentId: null };
    const child = { id: "c", parentId: "r" };
    const grandchild = { id: "g", parentId: "c" };
    // Deliberately reversed input.
    const ordered = orderCategoriesParentFirst([grandchild, child, root]);
    const pos = (id: string) => ordered.findIndex((r) => r.id === id);
    expect(pos("r")).toBeLessThan(pos("c"));
    expect(pos("c")).toBeLessThan(pos("g"));
    expect(ordered).toHaveLength(3);
  });

  it("does not loop on a malformed cycle and keeps every row once", () => {
    const a = { id: "a", parentId: "b" };
    const b = { id: "b", parentId: "a" };
    const ordered = orderCategoriesParentFirst([a, b]);
    expect(ordered).toHaveLength(2);
    expect(new Set(ordered.map((r) => r.id))).toEqual(new Set(["a", "b"]));
  });

  it("tolerates a parent id pointing outside the set", () => {
    const orphan = { id: "x", parentId: "missing" };
    const ordered = orderCategoriesParentFirst([orphan]);
    expect(ordered).toEqual([orphan]);
  });
});
