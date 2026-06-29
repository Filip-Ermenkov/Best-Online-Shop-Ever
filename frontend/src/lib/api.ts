import type {
  BannerList,
  CategoryTree,
  ProductDetail,
  ProductsPage,
} from "@shop/api";

/**
 * Typed fetchers for shop-api.
 *
 * ## Why plain `fetch` instead of Hono RPC `hc<AppType>(...)`
 *
 * The earlier implementation used `hc<AppType>(baseUrl)` which constructs a
 * fully typed RPC client where `api.products.$get(...)` is autocompleted and
 * the response shape is inferred from the server's Zod schemas. That's
 * elegant when it works, but `AppType = ReturnType<typeof buildApp>` is a
 * very deep generic chain that walks every route file, every Zod schema,
 * and every transitive workspace dep. On any setup where one link in the
 * chain degrades to `any` or `unknown` — most commonly because of npm
 * workspace symlink resolution differences between machines — the whole
 * `Client<AppType>` collapses to `unknown` and `next build` fails with
 * `Type error: 'api' is of type 'unknown'`.
 *
 * Plain `fetch` sidesteps the entire problem. We give up the typed URL
 * generation and typed query parameters, but we keep:
 *
 *   1. **Typed response shapes.** `Promise<ProductsPage>`, `Promise<CategoryTree>`,
 *      and `Promise<ProductDetail | null>` come from `@shop/api`'s explicit
 *      Zod-inferred DTO exports (`backend/shop-api/src/types.ts`). These are
 *      shallow types that don't depend on AppType, so they're bulletproof
 *      against the workspace-symlink class of issues.
 *   2. **Next.js cache integration.** `next: { revalidate, tags }` works the
 *      same on plain fetch as it did through Hono RPC.
 *   3. **Server / Client Component portability.** Same function signatures
 *      work in either context; Client callers pass `{ signal, cache:
 *      "no-store" }` for live-search semantics.
 *
 * We give up:
 *   - Compile-time URL safety (typo `${baseUrl}/protucts` → 404 at runtime
 *     instead of a TypeScript error). Mitigation: the API's Zod query
 *     validation rejects bad shapes with RFC 9457 problem details, so the
 *     error is surfaced cleanly.
 *   - Compile-time query-parameter shape checks. Mitigation: the function
 *     signature's `query` parameter is still typed (matches the Zod schema
 *     on the server).
 *
 * Configure via `NEXT_PUBLIC_SHOP_API_URL`. The fallback is the local dev
 * server that `npm run api:dev` spins up.
 */
const baseUrl =
  process.env.NEXT_PUBLIC_SHOP_API_URL?.replace(/\/+$/, "") ??
  "http://localhost:3001";

/**
 * Optional fetch init for the typed helpers. Mirrors the standard
 * `RequestInit` subset that storefront callers actually need, plus Next.js's
 * `next` data cache directives. Server Components usually omit this
 * (defaults apply); Client Components pass `{ signal, cache: "no-store" }`
 * for AbortController-aware live searches like the header autocomplete.
 *
 * When `init` is provided, it REPLACES the defaults — callers that want
 * both the next-cache options and a signal should spread them explicitly.
 */
export interface FetchInit {
  signal?: AbortSignal;
  cache?: RequestCache;
  next?: { revalidate?: number; tags?: string[] };
}

/**
 * Build a query string from an object of primitives, skipping
 * undefined/null. Booleans and numbers stringify per the API's Zod
 * preprocess hook (`v === "true" ? true : v === "false" ? false : v` for
 * inStock; `z.coerce.number()` for limit).
 */
function qs(params: Record<string, string | number | boolean | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    u.set(k, String(v));
  }
  const s = u.toString();
  return s ? "?" + s : "";
}

const COMMON_HEADERS = { Accept: "application/json" } as const;

/**
 * Convenience: fetch a page of products. Used from Server Components and
 * the header autocomplete Client Component.
 *
 * The explicit `Promise<ProductsPage>` return type is the contract callers
 * rely on — `(await fetchProducts(...)).items.map(p => ...)` always gets
 * `p: ProductSummary`, immune to any AppType inference fragility.
 */
export async function fetchProducts(
  query: {
    categorySlug?: string;
    inStock?: boolean;
    q?: string;
    sort?: "featured" | "newest" | "price_asc" | "price_desc";
    limit?: number;
    cursor?: string;
  },
  init?: FetchInit,
): Promise<ProductsPage> {
  const url = `${baseUrl}/products${qs(query)}`;
  const res = await fetch(url, {
    headers: COMMON_HEADERS,
    // Server-side default: cache for the same window as the API's CDN
    // hint, tagged so admin edits can purge via `revalidateTag('products')`.
    // Caller-provided init wins — Client Components typically pass
    // `{ signal, cache: "no-store" }` for live-search semantics.
    ...(init ?? { next: { revalidate: 300, tags: ["products"] } }),
  });
  if (!res.ok) {
    throw new ApiClientError(
      `GET /products failed (${res.status})`,
      res.status,
      await safeProblem(res),
    );
  }
  return (await res.json()) as ProductsPage;
}

/**
 * Convenience: fetch the full category tree. Used by every storefront
 * surface that needs the navigation menu, the homepage categories grid, etc.
 *
 * Tag-based revalidation: when an admin edits the tree (later slice), the
 * server action that performs the edit will call
 * `revalidateTag('categories')` to purge this fetch's Next.js cache entry
 * regardless of how stale the in-memory copy is.
 */
export async function fetchCategoryTree(): Promise<CategoryTree> {
  const res = await fetch(`${baseUrl}/categories`, {
    headers: COMMON_HEADERS,
    next: { revalidate: 300, tags: ["categories"] },
  });
  if (!res.ok) {
    throw new ApiClientError(
      `GET /categories failed (${res.status})`,
      res.status,
      await safeProblem(res),
    );
  }
  return (await res.json()) as CategoryTree;
}

/**
 * Convenience: fetch the active homepage banner slides (the hero carousel).
 * Returns `{ items: [] }` when no slides are active — the home page reads that
 * as "render no hero" per the spec. Degrades gracefully: the caller catches
 * `ApiClientError` and renders no hero rather than failing the whole page.
 *
 * Tagged `banners` so an admin edit (later: a `revalidateTag('banners')` server
 * action) can purge this cache entry; same 5-minute window as the catalog.
 */
export async function fetchBanners(): Promise<BannerList> {
  const res = await fetch(`${baseUrl}/banners`, {
    headers: COMMON_HEADERS,
    next: { revalidate: 300, tags: ["banners"] },
  });
  if (!res.ok) {
    throw new ApiClientError(
      `GET /banners failed (${res.status})`,
      res.status,
      await safeProblem(res),
    );
  }
  return (await res.json()) as BannerList;
}

/** Convenience: fetch a single product by slug. Returns null on 404. */
export async function fetchProductBySlug(
  slug: string,
): Promise<ProductDetail | null> {
  // URL-encode the slug defensively even though the route only accepts
  // [a-z0-9-]+ — caller pre-validation could be looser.
  const res = await fetch(`${baseUrl}/products/${encodeURIComponent(slug)}`, {
    headers: COMMON_HEADERS,
    next: { revalidate: 300, tags: ["products", `product:${slug}`] },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new ApiClientError(
      `GET /products/${slug} failed (${res.status})`,
      res.status,
      await safeProblem(res),
    );
  }
  return (await res.json()) as ProductDetail;
}

interface Problem {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
}

async function safeProblem(res: Response): Promise<Problem | undefined> {
  try {
    return (await res.json()) as Problem;
  } catch {
    return undefined;
  }
}

export class ApiClientError extends Error {
  status: number;
  problem?: Problem;
  constructor(message: string, status: number, problem?: Problem) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.problem = problem;
  }
}
