import { describe, expect, it } from "vitest";
import {
  REDIRECT_MAX_HOPS,
  resolveRedirectChain,
  type RedirectRow,
} from "../../src/lib/redirect-resolve.js";
import {
  buildSitemapEntries,
  type SitemapCategoryRow,
  type SitemapProductRow,
} from "../../src/lib/sitemap.js";

/**
 * Pure-unit coverage for the SEO/crawlability primitives — no DB, mirroring the
 * @shop/auth crypto suites and tests/lib/guest-track.ts. Route-level behaviour
 * (DB-backed) lives in tests/routes/seo.test.ts.
 */

function rowMap(entries: Array<[string, RedirectRow]>): (p: string) => RedirectRow | undefined {
  const m = new Map(entries);
  return (p) => m.get(p);
}

describe("resolveRedirectChain", () => {
  const catUrl = (id: string): string | null =>
    ({ c1: "/products/elektronika", c2: "/products/elektronika/telefoni" })[id] ?? null;

  it("returns null when the path has no redirect", () => {
    expect(
      resolveRedirectChain({
        requestedPath: "/products/whatever",
        lookupRedirect: () => undefined,
        categoryUrlById: catUrl,
      }),
    ).toBeNull();
  });

  it("resolves a single hop to a surviving category", () => {
    const lookup = rowMap([
      [
        "/products/elektronika/star-telefon",
        { targetKind: "category", targetCategoryId: "c1", targetProductId: null, statusCode: 301 },
      ],
    ]);
    expect(
      resolveRedirectChain({
        requestedPath: "/products/elektronika/star-telefon",
        lookupRedirect: lookup,
        categoryUrlById: catUrl,
      }),
    ).toEqual({ target: "/products/elektronika", statusCode: 301 });
  });

  it("resolves a deleted root to home", () => {
    const lookup = rowMap([
      ["/products/star-root", { targetKind: "home", targetCategoryId: null, targetProductId: null, statusCode: 301 }],
    ]);
    expect(
      resolveRedirectChain({
        requestedPath: "/products/star-root",
        lookupRedirect: lookup,
        categoryUrlById: catUrl,
      }),
    ).toEqual({ target: "/", statusCode: 301 });
  });

  it("collapses a chain to the final target (deleted ancestor → home)", () => {
    const lookup = rowMap([
      [
        "/products/elektronika/star",
        { targetKind: "category", targetCategoryId: "c1", targetProductId: null, statusCode: 301 },
      ],
      [
        "/products/elektronika",
        { targetKind: "home", targetCategoryId: null, targetProductId: null, statusCode: 301 },
      ],
    ]);
    expect(
      resolveRedirectChain({
        requestedPath: "/products/elektronika/star",
        lookupRedirect: lookup,
        categoryUrlById: catUrl,
      }),
    ).toEqual({ target: "/", statusCode: 301 });
  });

  it("breaks a cycle and refuses to self-redirect (returns null)", () => {
    const lookup = rowMap([
      ["/a", { targetKind: "category", targetCategoryId: "toB", targetProductId: null, statusCode: 301 }],
      ["/b", { targetKind: "category", targetCategoryId: "toA", targetProductId: null, statusCode: 301 }],
    ]);
    const cu = (id: string) => (id === "toB" ? "/b" : id === "toA" ? "/a" : null);
    expect(
      resolveRedirectChain({ requestedPath: "/a", lookupRedirect: lookup, categoryUrlById: cu }),
    ).toBeNull();
  });

  it("passes a 302/307 status through and normalises odd codes to 301", () => {
    const move = rowMap([
      ["/m", { targetKind: "category", targetCategoryId: "c1", targetProductId: null, statusCode: 302 }],
    ]);
    expect(
      resolveRedirectChain({ requestedPath: "/m", lookupRedirect: move, categoryUrlById: catUrl }),
    ).toEqual({ target: "/products/elektronika", statusCode: 302 });

    const odd = rowMap([
      ["/o", { targetKind: "home", targetCategoryId: null, targetProductId: null, statusCode: 418 }],
    ]);
    expect(
      resolveRedirectChain({ requestedPath: "/o", lookupRedirect: odd, categoryUrlById: catUrl }),
    ).toEqual({ target: "/", statusCode: 301 });
  });

  it("falls back to home when the target category can't be resolved", () => {
    const lookup = rowMap([
      ["/gone", { targetKind: "category", targetCategoryId: "missing", targetProductId: null, statusCode: 301 }],
    ]);
    expect(
      resolveRedirectChain({ requestedPath: "/gone", lookupRedirect: lookup, categoryUrlById: catUrl }),
    ).toEqual({ target: "/", statusCode: 301 });
  });

  it("stops at the hop cap on a long chain without looping forever", () => {
    // Build a long linear chain /n0 → /n1 → ... each a category whose URL is the
    // next node. It never terminates in a non-redirect, so the cap must bound it.
    const N = REDIRECT_MAX_HOPS + 5;
    const entries: Array<[string, RedirectRow]> = [];
    for (let i = 0; i < N; i++) {
      entries.push([
        `/n${i}`,
        { targetKind: "category", targetCategoryId: `to${i + 1}`, targetProductId: null, statusCode: 301 },
      ]);
    }
    const lookup = rowMap(entries);
    const cu = (id: string) => {
      const m = /^to(\d+)$/.exec(id);
      return m ? `/n${m[1]}` : null;
    };
    const res = resolveRedirectChain({ requestedPath: "/n0", lookupRedirect: lookup, categoryUrlById: cu });
    // It terminates (no infinite loop) and lands on some /nK within the cap.
    expect(res).not.toBeNull();
    expect(res!.target).toMatch(/^\/n\d+$/);
  });
});

describe("buildSitemapEntries", () => {
  const d = new Date("2026-06-16T10:00:00.000Z");
  const cats: SitemapCategoryRow[] = [
    { id: "root", slug: "elektronika", name: "Електроника", parentId: null, updatedAt: d },
    { id: "child", slug: "telefoni", name: "Телефони", parentId: "root", updatedAt: d },
  ];

  it("builds canonical category paths in stable order", () => {
    const out = buildSitemapEntries(cats, []);
    expect(out.categories.map((e) => e.path)).toEqual([
      "/products/elektronika",
      "/products/elektronika/telefoni",
    ]);
    expect(out.categories[0]!.lastModified.getTime()).toBe(d.getTime());
  });

  it("builds a product URL under its category chain", () => {
    const prods: SitemapProductRow[] = [{ slug: "telefon-x", categoryId: "child", updatedAt: d }];
    const out = buildSitemapEntries(cats, prods);
    expect(out.products.map((e) => e.path)).toEqual([
      "/products/elektronika/telefoni/telefon-x",
    ]);
  });

  it("falls back to a bare /products/<slug> for a product with no category", () => {
    const prods: SitemapProductRow[] = [{ slug: "orphan", categoryId: null, updatedAt: d }];
    const out = buildSitemapEntries(cats, prods);
    expect(out.products.map((e) => e.path)).toEqual(["/products/orphan"]);
  });

  it("skips an orphaned category (broken parent chain) rather than emit a broken URL", () => {
    const orphanCats: SitemapCategoryRow[] = [
      { id: "x", slug: "x", name: "X", parentId: "ghost", updatedAt: d },
    ];
    const out = buildSitemapEntries(orphanCats, []);
    expect(out.categories).toEqual([]);
  });
});
