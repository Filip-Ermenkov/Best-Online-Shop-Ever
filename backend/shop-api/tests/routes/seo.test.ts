import { beforeAll, describe, expect, it } from "vitest";
import { schema } from "@shop/db";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { getDb } from "../../src/lib/db.js";
import { seedCategory, seedProduct } from "../fixtures.js";

let app: ReturnType<typeof buildApp>;

beforeAll(() => {
  app = buildApp();
});

/**
 * HTTP-level coverage for the SEO surface (GET /sitemap, GET /redirects/resolve),
 * same style as categories.test.ts. Fixtures seeded explicitly per test
 * (per-test.ts truncates between tests). Pure resolution/build logic is unit-
 * tested in tests/lib/seo.test.ts.
 */

describe("GET /sitemap", () => {
  it("returns empty arrays for an empty catalog, with cache headers", async () => {
    const res = await app.request("/sitemap");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/s-maxage=3600/);
    expect(res.headers.get("vary")).toContain("Accept-Encoding");
    const body = (await res.json()) as {
      categories: unknown[];
      products: unknown[];
      generatedAt: string;
    };
    expect(body.categories).toEqual([]);
    expect(body.products).toEqual([]);
    expect(typeof body.generatedAt).toBe("string");
    expect(new Date(body.generatedAt).toString()).not.toBe("Invalid Date");
  });

  it("emits canonical paths + ISO lastModified for live categories and products", async () => {
    const electronics = await seedCategory({ slug: "electronics", name: "Електроника" });
    const phones = await seedCategory({
      slug: "phones",
      name: "Телефони",
      parentId: electronics.id,
    });
    await seedProduct({
      slug: "telefon-x",
      code: "TEL-X",
      name: "Телефон X",
      priceCents: 1999,
      categoryId: phones.id,
    });

    const res = await app.request("/sitemap");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      categories: Array<{ path: string; lastModified: string }>;
      products: Array<{ path: string; lastModified: string }>;
    };

    expect(body.categories.map((e) => e.path)).toEqual([
      "/products/electronics",
      "/products/electronics/phones",
    ]);
    expect(body.products.map((e) => e.path)).toEqual([
      "/products/electronics/phones/telefon-x",
    ]);
    // lastModified is an ISO-8601 instant.
    expect(body.products[0]!.lastModified).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
  });

  it("falls back to a bare /products/<slug> for a product with no category", async () => {
    await seedProduct({
      slug: "loose-item",
      code: "LOOSE-1",
      name: "Свободен артикул",
      priceCents: 500,
      categoryId: null,
    });
    const res = await app.request("/sitemap");
    const body = (await res.json()) as { products: Array<{ path: string }> };
    expect(body.products.map((e) => e.path)).toEqual(["/products/loose-item"]);
  });

  it("excludes soft-deleted categories and products", async () => {
    const electronics = await seedCategory({ slug: "electronics", name: "Електроника" });
    const product = await seedProduct({
      slug: "gone",
      code: "GONE-1",
      name: "Изтрит",
      priceCents: 100,
      categoryId: electronics.id,
    });
    await getDb()
      .update(schema.categories)
      .set({ deletedAt: new Date() })
      .where(eq(schema.categories.id, electronics.id));
    await getDb()
      .update(schema.products)
      .set({ deletedAt: new Date() })
      .where(eq(schema.products.id, product.id));

    const res = await app.request("/sitemap");
    const body = (await res.json()) as {
      categories: unknown[];
      products: unknown[];
    };
    expect(body.categories).toEqual([]);
    expect(body.products).toEqual([]);
  });
});

describe("GET /redirects/resolve", () => {
  it("400s when path is missing", async () => {
    const res = await app.request("/redirects/resolve");
    expect(res.status).toBe(400);
  });

  it("400s when path is not absolute", async () => {
    const res = await app.request("/redirects/resolve?path=products/x");
    expect(res.status).toBe(400);
  });

  it("404s when no redirect is registered for the path", async () => {
    const res = await app.request(
      "/redirects/resolve?path=" + encodeURIComponent("/products/nothing-here"),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/problem\+json/);
  });

  it("resolves a deleted URL to its surviving category, with cache headers", async () => {
    const electronics = await seedCategory({ slug: "electronics", name: "Електроника" });
    await getDb()
      .insert(schema.redirects)
      .values({
        sourcePath: "/products/electronics/old-phone",
        targetKind: "category",
        targetCategoryId: electronics.id,
        statusCode: 301,
      });

    const res = await app.request(
      "/redirects/resolve?path=" + encodeURIComponent("/products/electronics/old-phone"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/s-maxage=300/);
    const body = (await res.json()) as { target: string; statusCode: number };
    expect(body).toEqual({ target: "/products/electronics", statusCode: 301 });
  });

  it("resolves a deleted root to home", async () => {
    await getDb()
      .insert(schema.redirects)
      .values({
        sourcePath: "/products/old-root",
        targetKind: "home",
        targetCategoryId: null,
        statusCode: 301,
      });
    const res = await app.request(
      "/redirects/resolve?path=" + encodeURIComponent("/products/old-root"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { target: string; statusCode: number };
    expect(body).toEqual({ target: "/", statusCode: 301 });
  });

  it("collapses a redirect chain to the final target", async () => {
    const electronics = await seedCategory({ slug: "electronics", name: "Електроника" });
    // /products/electronics/old → (category electronics) /products/electronics
    await getDb().insert(schema.redirects).values({
      sourcePath: "/products/electronics/old",
      targetKind: "category",
      targetCategoryId: electronics.id,
      statusCode: 301,
    });
    // /products/electronics → home  (as if electronics itself were later deleted)
    await getDb().insert(schema.redirects).values({
      sourcePath: "/products/electronics",
      targetKind: "home",
      targetCategoryId: null,
      statusCode: 301,
    });

    const res = await app.request(
      "/redirects/resolve?path=" + encodeURIComponent("/products/electronics/old"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { target: string; statusCode: number };
    expect(body).toEqual({ target: "/", statusCode: 301 });
  });
});

describe("/openapi.json includes the SEO surface", () => {
  it("registers /sitemap and /redirects/resolve with their components", async () => {
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);
    const spec = (await res.json()) as {
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };
    expect(spec.paths).toHaveProperty("/sitemap");
    expect(spec.paths).toHaveProperty("/redirects/resolve");
    expect(spec.components.schemas).toHaveProperty("SitemapResponse");
    expect(spec.components.schemas).toHaveProperty("RedirectResolution");
  });
});
