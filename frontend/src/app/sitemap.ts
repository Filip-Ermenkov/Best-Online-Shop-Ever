import type { MetadataRoute } from "next";
import { fetchSitemapData } from "@/lib/seo/client";

/**
 * Dynamic XML sitemap (`/sitemap.xml`) — Next.js metadata route.
 *
 * Emits the live catalog (every non-deleted category + product, with an
 * ACCURATE `lastModified` from the DB `updated_at`) plus the public static
 * pages. `lastmod` is the one sitemap field search engines actually weight, and
 * only when it's trustworthy — Google ignores it site-wide once it looks
 * fabricated — so the dates come from the source of truth (`GET /sitemap` on the
 * API), never `new Date()`. `priority` / `changeFrequency` are largely ignored
 * by Google; included as light hints for other engines.
 *
 * Regenerated hourly (`revalidate`), matching the API's cache window. The data
 * fetch degrades to static-only on any API hiccup so the sitemap is never empty
 * or a build-breaker.
 *
 * Scale: a single sitemap file caps at 50,000 URLs / 50 MB. This catalog is far
 * below that (the §16.3 search threshold is 20K SKUs); we defensively slice at
 * the cap. Crossing it is the documented trigger to shard via Next.js
 * `generateSitemaps()` behind a sitemap index.
 */

export const revalidate = 3600;

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "") ?? "http://localhost:3000";

const SITEMAP_MAX_URLS = 50_000;

/** Public, indexable static pages. (Private/utility routes are excluded — see robots.ts.) */
const STATIC_ENTRIES: MetadataRoute.Sitemap = [
  { url: `${SITE_URL}/`, changeFrequency: "daily", priority: 1 },
  { url: `${SITE_URL}/products/new-products`, changeFrequency: "daily", priority: 0.8 },
  { url: `${SITE_URL}/accessibility`, changeFrequency: "yearly", priority: 0.2 },
  { url: `${SITE_URL}/security`, changeFrequency: "yearly", priority: 0.2 },
  { url: `${SITE_URL}/terms/withdrawal`, changeFrequency: "yearly", priority: 0.3 },
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  let catalog: MetadataRoute.Sitemap = [];

  try {
    const data = await fetchSitemapData();
    const categoryEntries: MetadataRoute.Sitemap = data.categories.map((e) => ({
      url: `${SITE_URL}${e.path}`,
      lastModified: new Date(e.lastModified),
      changeFrequency: "weekly",
      priority: 0.6,
    }));
    const productEntries: MetadataRoute.Sitemap = data.products.map((e) => ({
      url: `${SITE_URL}${e.path}`,
      lastModified: new Date(e.lastModified),
      changeFrequency: "weekly",
      priority: 0.7,
    }));
    catalog = [...categoryEntries, ...productEntries];
  } catch {
    // API unreachable at (re)generation time — ship the static pages rather than
    // an empty file or a failed build. The next revalidation picks the catalog up.
    catalog = [];
  }

  const all = [...STATIC_ENTRIES, ...catalog];
  return all.length > SITEMAP_MAX_URLS ? all.slice(0, SITEMAP_MAX_URLS) : all;
}
