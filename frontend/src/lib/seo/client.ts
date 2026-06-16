import type { RedirectResolution, SitemapResponse } from "@shop/api";

/**
 * SEO data client — talks to the public `shop-api` SEO surface (`/sitemap`,
 * `/redirects/resolve`). Plain `fetch` + concrete DTO types re-exported from
 * `@shop/api`, exactly like `lib/api.ts` (no Hono RPC — see that file for why).
 *
 * Both helpers run server-side only: `fetchSitemapData` from `app/sitemap.ts`,
 * `resolveRedirect` from the `/products/[...path]` catch-all on the would-be-404
 * path. Neither runs in the proxy (kept thin by design).
 */

const baseUrl =
  process.env.NEXT_PUBLIC_SHOP_API_URL?.replace(/\/+$/, "") ??
  "http://localhost:3001";

const COMMON_HEADERS = { Accept: "application/json" } as const;

/**
 * Fetch sitemap source data (canonical paths + accurate `lastmod` for the live
 * catalog). Revalidated hourly and tagged so a future admin catalog edit can
 * purge it via `revalidateTag('sitemap')`. Throws on a non-OK response — the
 * caller (`app/sitemap.ts`) catches and degrades to static entries so a
 * transient API hiccup never produces an empty sitemap.
 */
export async function fetchSitemapData(): Promise<SitemapResponse> {
  const res = await fetch(`${baseUrl}/sitemap`, {
    headers: COMMON_HEADERS,
    next: { revalidate: 3600, tags: ["sitemap", "products", "categories"] },
  });
  if (!res.ok) {
    throw new Error(`GET /sitemap failed (${res.status})`);
  }
  return (await res.json()) as SitemapResponse;
}

/**
 * Resolve a deleted storefront path to its 301 target, or `null` when no
 * redirect is registered (the caller then renders the real 404). The path is the
 * full storefront path, e.g. `/products/elektronika/star-telefon`.
 *
 * Cached for the same window as the catalog and tagged `redirects` so a future
 * delete can purge it. Any unexpected (non-404) failure resolves to `null` too:
 * a redirect-lookup outage must degrade to a normal 404, never to a 500 on a
 * page that would otherwise just be "not found".
 */
export async function resolveRedirect(
  path: string,
): Promise<RedirectResolution | null> {
  try {
    const res = await fetch(
      `${baseUrl}/redirects/resolve?path=${encodeURIComponent(path)}`,
      {
        headers: COMMON_HEADERS,
        next: { revalidate: 300, tags: ["redirects"] },
      },
    );
    if (!res.ok) return null; // 404 (no redirect) or any transient error → real 404
    return (await res.json()) as RedirectResolution;
  } catch {
    return null;
  }
}
