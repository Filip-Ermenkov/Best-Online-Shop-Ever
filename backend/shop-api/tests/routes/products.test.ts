import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import {
  seedCategory,
  seedImage,
  seedProduct,
  seedSmallCatalog,
} from "../fixtures.js";

let app: ReturnType<typeof buildApp>;

beforeAll(() => {
  app = buildApp();
});

/**
 * Tests are HTTP-level. We call app.request(url) directly — no server boot.
 * That's the canonical way to test a Hono app.
 *
 * Each test re-seeds because per-test.ts truncated everything. This trades a
 * little redundancy for full isolation, which is the right tradeoff at this
 * scale.
 */

describe("GET /products", () => {
  it("returns an empty page when there are no products", async () => {
    const res = await app.request("/products");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/s-maxage=300/);
    const body = await res.json();
    expect(body).toEqual({ items: [], nextCursor: null });
  });

  it("returns products sorted by displayOrder by default (featured)", async () => {
    await seedSmallCatalog();
    const res = await app.request("/products");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((p: { slug: string }) => p.slug)).toEqual([
      "demo-headphones",
      "demo-watch",
      "demo-drill",
    ]);
    expect(body.nextCursor).toBeNull();
    // Verify the summary shape.
    const first = body.items[0];
    expect(first).toMatchObject({
      slug: "demo-headphones",
      code: "DEMO-001",
      name: "Demo Headphones",
      priceCents: 9999,
      currency: "EUR",
      stockStatus: "in_stock",
      isNew: true,
    });
    expect(first.primaryImage).toMatchObject({
      alt: "front",
      displayOrder: 0,
    });
    // No fully-qualified URL stored — image URL is derived.
    expect(first.primaryImage.url).toMatch(/^https:\/\//);
  });

  it("supports sort=price_asc and sort=price_desc", async () => {
    await seedSmallCatalog();
    const asc = await app
      .request("/products?sort=price_asc")
      .then((r) => r.json());
    expect(asc.items.map((p: { priceCents: number }) => p.priceCents)).toEqual([
      5999, 9999, 24999,
    ]);

    const desc = await app
      .request("/products?sort=price_desc")
      .then((r) => r.json());
    expect(desc.items.map((p: { priceCents: number }) => p.priceCents)).toEqual([
      24999, 9999, 5999,
    ]);
  });

  it("filters by inStock=true", async () => {
    await seedSmallCatalog();
    const res = await app.request("/products?inStock=true");
    const body = await res.json();
    expect(body.items.map((p: { slug: string }) => p.slug)).toEqual([
      "demo-headphones",
      "demo-watch",
    ]);
  });

  it("filters by categorySlug, returning empty when unknown", async () => {
    const { cat } = await seedSmallCatalog();
    expect(cat.slug).toBe("demo-cat");

    const inCat = await app
      .request("/products?categorySlug=demo-cat")
      .then((r) => r.json());
    expect(inCat.items).toHaveLength(3);

    const empty = await app
      .request("/products?categorySlug=does-not-exist")
      .then((r) => r.json());
    expect(empty).toEqual({ items: [], nextCursor: null });
  });

  it("performs free-text search over name and code (ILIKE)", async () => {
    await seedSmallCatalog();
    const a = await app
      .request("/products?q=watch")
      .then((r) => r.json());
    expect(a.items.map((p: { slug: string }) => p.slug)).toEqual(["demo-watch"]);

    const b = await app
      .request("/products?q=DEMO-003")
      .then((r) => r.json());
    expect(b.items.map((p: { slug: string }) => p.slug)).toEqual(["demo-drill"]);
  });

  it("paginates with cursor — page boundaries are stable and items don't repeat", async () => {
    // 5 products — page size 2 → expect 3 pages of [2,2,1].
    const cat = await seedCategory({ slug: "p-cat", name: "Pagination cat" });
    for (let i = 0; i < 5; i++) {
      await seedProduct({
        slug: `pag-${i}`,
        code: `PAG-${i}`,
        name: `Paginated ${i}`,
        priceCents: 1000 + i,
        categoryId: cat.id,
        displayOrder: i,
      });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 4 && (i === 0 || cursor); i++) {
      const url: string =
        cursor === null
          ? "/products?limit=2"
          : `/products?limit=2&cursor=${encodeURIComponent(cursor)}`;
      const res = await app.request(url);
      expect(res.status).toBe(200);
      const body = await res.json();
      for (const p of body.items as { slug: string }[]) seen.push(p.slug);
      cursor = body.nextCursor;
    }
    expect(seen).toEqual(["pag-0", "pag-1", "pag-2", "pag-3", "pag-4"]);
    expect(cursor).toBeNull();
  });

  it("rejects a cursor created for a different sort", async () => {
    await seedSmallCatalog();
    const page1 = await app
      .request("/products?sort=newest&limit=1")
      .then((r) => r.json());
    expect(page1.nextCursor).toBeTruthy();

    const res = await app.request(
      `/products?sort=price_asc&limit=1&cursor=${encodeURIComponent(page1.nextCursor)}`,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toMatch(/application\/problem\+json/);
    const problem = await res.json();
    expect(problem).toMatchObject({ status: 400, title: "Bad Request" });
  });

  it("rejects malformed query parameters with 400 + Problem Details", async () => {
    const res = await app.request("/products?limit=9999");
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toMatch(/application\/problem\+json/);
    const problem = await res.json();
    expect(problem).toMatchObject({
      status: 400,
      title: "Bad Request",
      detail: "Request validation failed",
    });
    expect(problem.errors?.[0]?.path).toContain("limit");
  });

  it("returns 304 on conditional GET when ETag matches", async () => {
    await seedSmallCatalog();
    const first = await app.request("/products");
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    const second = await app.request("/products", {
      headers: { "If-None-Match": etag! },
    });
    expect(second.status).toBe(304);
  });
});

describe("GET /products/:slug", () => {
  it("returns a product with all images and a breadcrumb chain", async () => {
    const root = await seedCategory({
      slug: "root-cat",
      name: "Root",
      displayOrder: 0,
    });
    const sub = await seedCategory({
      slug: "sub-cat",
      name: "Sub",
      parentId: root.id,
      displayOrder: 0,
    });
    const p = await seedProduct({
      slug: "single-product",
      code: "SP-001",
      name: "Single Product",
      description: "Detailed description.",
      priceCents: 12345,
      categoryId: sub.id,
      isNew: true,
    });
    await seedImage({ productId: p.id, s3Key: "sp/a.jpg", displayOrder: 1 });
    await seedImage({ productId: p.id, s3Key: "sp/b.jpg", displayOrder: 0 });

    const res = await app.request("/products/single-product");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.slug).toBe("single-product");
    expect(body.priceCents).toBe(12345);
    expect(body.description).toBe("Detailed description.");
    expect(body.images.map((i: { s3Key?: string; displayOrder: number }) => i.displayOrder))
      .toEqual([0, 1]);
    expect(body.breadcrumb.map((c: { slug: string }) => c.slug)).toEqual([
      "root-cat",
      "sub-cat",
    ]);
  });

  it("returns 404 for unknown slug with Problem Details", async () => {
    const res = await app.request("/products/no-such-thing");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/application\/problem\+json/);
    const problem = await res.json();
    expect(problem.title).toBe("Not Found");
    expect(problem.detail).toMatch(/no-such-thing/);
  });

  it("returns 404 for soft-deleted product", async () => {
    const cat = await seedCategory({ slug: "del-cat", name: "Del" });
    const p = await seedProduct({
      slug: "deleted-product",
      code: "DEL-001",
      name: "Deleted",
      priceCents: 100,
      categoryId: cat.id,
    });
    // Soft-delete via raw update.
    const { schema } = await import("@shop/db");
    const { eq } = await import("drizzle-orm");
    const { getDb } = await import("../../src/lib/db.js");
    await getDb()
      .update(schema.products)
      .set({ deletedAt: new Date() })
      .where(eq(schema.products.id, p.id));

    const res = await app.request("/products/deleted-product");
    expect(res.status).toBe(404);
  });
});

describe("GET /health & /openapi.json", () => {
  it("/health returns 200 ok", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it("/openapi.json returns a 3.1 spec with the products routes", async () => {
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);
    const spec = await res.json();
    expect(spec.openapi).toMatch(/^3\.1/);
    expect(spec.paths).toHaveProperty("/products");
    expect(spec.paths).toHaveProperty("/products/{slug}");
  });
});
