/**
 * Pure sitemap entry builder.
 *
 * Turns flat category + product rows into canonical storefront paths with an
 * accurate `lastModified`, reusing the SAME URL helpers the rest of the app uses
 * (`category-tree.ts`) so a sitemap URL can never drift from the URL the
 * storefront actually serves. The `GET /sitemap` route wires the DB query in;
 * the storefront `app/sitemap.ts` consumes the result and prefixes the origin.
 *
 * ## Why server-side, not the frontend paging `/products`
 * `lastmod` is the single most valuable sitemap field, but ONLY if it is
 * accurate — Google ignores `lastmod` site-wide the moment it finds the dates
 * unreliable. The real `updated_at` lives in the DB, and the `/products` list
 * DTO does not expose it, so we build entries here from the source of truth in
 * one query rather than reconstructing them on the client.
 *
 * ## Scale
 * A sitemap file caps at 50,000 URLs / 50 MB; past that you shard behind a
 * sitemap index (Next.js `generateSitemaps()`). This shop's catalog is far
 * under that (the §16.3 search threshold is 20K SKUs), so a single sitemap is
 * correct today. The storefront guards the 50K cap defensively; crossing it is
 * the documented trigger to switch to `generateSitemaps()`.
 */

import {
  ancestorSlugChain,
  categoryUrlFromChain,
  productUrl,
  type CatRow,
} from "./category-tree.js";

/** A category row for the sitemap — `CatRow` plus its modification time. */
export interface SitemapCategoryRow extends CatRow {
  updatedAt: Date;
}

/** A product row for the sitemap. `categoryId` null → bare `/products/<slug>`. */
export interface SitemapProductRow {
  slug: string;
  categoryId: string | null;
  updatedAt: Date;
}

export interface SitemapEntry {
  /** Absolute-from-root storefront path, e.g. `/products/elektronika/telefon`. */
  path: string;
  lastModified: Date;
}

export interface SitemapEntries {
  categories: SitemapEntry[];
  products: SitemapEntry[];
}

/** Stable ordering — deterministic output keeps caches/diffs quiet. */
function byPath(a: SitemapEntry, b: SitemapEntry): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * Build canonical sitemap entries from live category + product rows.
 *
 * `categories` MUST be the full set of categories that participate in any live
 * URL (i.e. the live tree) so `ancestorSlugChain` can build every chain. Pass
 * non-deleted rows; the caller filters `deleted_at IS NULL`.
 */
export function buildSitemapEntries(
  categories: SitemapCategoryRow[],
  products: SitemapProductRow[],
): SitemapEntries {
  const categoryEntries: SitemapEntry[] = [];
  for (const cat of categories) {
    const chain = ancestorSlugChain(categories, cat.id);
    if (!chain) continue; // orphaned row (data bug) — skip rather than emit a broken URL
    categoryEntries.push({
      path: categoryUrlFromChain(chain),
      lastModified: cat.updatedAt,
    });
  }

  const productEntries: SitemapEntry[] = [];
  for (const prod of products) {
    if (prod.categoryId) {
      const chain = ancestorSlugChain(categories, prod.categoryId);
      if (chain) {
        productEntries.push({
          path: productUrl(chain, prod.slug),
          lastModified: prod.updatedAt,
        });
        continue;
      }
    }
    // No category (or unbuildable chain) → the storefront serves the product in
    // place at the bare slug, so that's its canonical URL.
    productEntries.push({
      path: `/products/${prod.slug}`,
      lastModified: prod.updatedAt,
    });
  }

  categoryEntries.sort(byPath);
  productEntries.sort(byPath);
  return { categories: categoryEntries, products: productEntries };
}
