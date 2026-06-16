/**
 * Pure 301-redirect chain resolver.
 *
 * The `redirects` table is WRITTEN by the admin category cascade-delete
 * (`routes/admin/categories.ts`) — every removed category/product URL gets a row
 * pointing at the nearest surviving ancestor (or home). Until this slice nothing
 * SERVED those rows, so a deleted URL returned a 404 instead of a 301, silently
 * leaking SEO link equity. This module is the resolution half; the storefront
 * catch-all (`/products/[...path]`) consumes it on the would-be-404 path via the
 * `GET /redirects/resolve` endpoint (see `routes/seo.ts`).
 *
 * Why a PURE function with injected lookups: it unit-tests with in-memory maps
 * and no DB, exactly like `guest-track.ts` / `rate-limit.ts`. The route wires the
 * real DB-backed lookups in.
 *
 * ## Chain resolution
 * Deletes only ever point at a *surviving* ancestor, so chains don't normally
 * form. But a later delete of that ancestor writes a fresh redirect for ITS url,
 * turning `A → B` into `A → B → home`. Google follows up to ~5 hops and
 * recommends ≤ 2 (John Mueller), so we collapse the whole chain server-side and
 * hand the client a single hop to the FINAL target. A `seen` set guards against a
 * pathological cycle, and `maxHops` bounds the walk.
 *
 * ## Status code
 * The stored `status_code` is almost always 301. Google treats 301 and 308 as
 * equivalent for indexing/PageRank, and Next.js `permanentRedirect()` emits 308 —
 * so the storefront serves a 308 for any 301/308 target with no SEO penalty. We
 * still pass the code through so a future 302/307 ("short-term move") works too.
 */

/** A redirect row, narrowed to the fields resolution needs. */
export interface RedirectRow {
  targetKind: "category" | "product" | "home";
  targetCategoryId: string | null;
  targetProductId: string | null;
  statusCode: number;
}

export interface ResolvedRedirect {
  /** Absolute-from-root storefront path, e.g. `/products/elektronika` or `/`. */
  target: string;
  /** 301 | 302 | 307 | 308 — normalised; storefront maps 301/308 → permanentRedirect. */
  statusCode: 301 | 302 | 307 | 308;
}

/**
 * Default hop cap. Generous relative to Google's ~5-hop follow limit so a deep
 * but legitimate chain still collapses to one response; the cycle guard is the
 * real safety net, this is just belt-and-braces against a runaway walk.
 */
export const REDIRECT_MAX_HOPS = 10;

/** Permanent (301) is the only code the delete writer emits; the rest are reserved. */
function normaliseStatus(code: number): 301 | 302 | 307 | 308 {
  return code === 302 || code === 307 || code === 308 ? code : 301;
}

/** Map one redirect row to its immediate target path. Unknown/missing → home. */
function targetPath(
  row: RedirectRow,
  categoryUrlById: (id: string) => string | null,
  productUrlById: (id: string) => string | null,
): string {
  switch (row.targetKind) {
    case "home":
      return "/";
    case "category":
      return (row.targetCategoryId && categoryUrlById(row.targetCategoryId)) || "/";
    case "product":
      // Reserved — the delete writer never emits this today, but resolve it
      // defensively so a future product-aliasing slice "just works".
      return (row.targetProductId && productUrlById(row.targetProductId)) || "/";
    default:
      return "/";
  }
}

/**
 * Resolve `requestedPath` to its final redirect target, following a chain.
 *
 * @returns the final `{ target, statusCode }`, or `null` when there is no
 *   redirect for `requestedPath` (caller → 404) or the chain degenerates to a
 *   self-redirect (target === requestedPath).
 */
export function resolveRedirectChain(opts: {
  requestedPath: string;
  /** Synchronous lookup: the row whose `source_path === path`, or undefined. */
  lookupRedirect: (path: string) => RedirectRow | undefined;
  /** Canonical storefront URL for a (possibly later-deleted) category, or null. */
  categoryUrlById: (id: string) => string | null;
  /** Optional: canonical URL for a product (reserved target kind). */
  productUrlById?: (id: string) => string | null;
  maxHops?: number;
}): ResolvedRedirect | null {
  const {
    requestedPath,
    lookupRedirect,
    categoryUrlById,
    productUrlById = () => null,
    maxHops = REDIRECT_MAX_HOPS,
  } = opts;

  const first = lookupRedirect(requestedPath);
  if (!first) return null;

  const seen = new Set<string>([requestedPath]);
  let row: RedirectRow = first;
  let statusCode = normaliseStatus(row.statusCode);
  let target = targetPath(row, categoryUrlById, productUrlById);
  let hops = 1;

  // Follow the chain while the current target is itself a redirect source and
  // we haven't already visited it (cycle guard) and we're under the hop cap.
  while (hops < maxHops && !seen.has(target)) {
    const next = lookupRedirect(target);
    if (!next) break; // target is a final, non-redirecting path → done
    seen.add(target);
    row = next;
    statusCode = normaliseStatus(row.statusCode);
    target = targetPath(row, categoryUrlById, productUrlById);
    hops += 1;
  }

  // A redirect to the exact path that was requested is not a usable redirect
  // (it would loop in the browser); treat it as "no redirect" so the caller 404s.
  if (target === requestedPath) return null;

  return { target, statusCode };
}
