import { hc } from "hono/client";
import type { AppType } from "@shop/api";

/**
 * Type-safe Hono RPC client for shop-api.
 *
 *   import { api } from "@/lib/api";
 *   const res = await api.products.$get({ query: { sort: "newest" } });
 *   if (!res.ok) { ... }
 *   const page = await res.json();   // strongly typed as ProductsPage
 *
 * `hc<AppType>()` consumes only TYPES from @shop/api — there is no runtime
 * code from the API package in the browser bundle. Tree-shaking strips it
 * out completely.
 *
 * Configure via NEXT_PUBLIC_SHOP_API_URL. The fallback is the local dev
 * server that `npm run api:dev` spins up.
 */
const baseUrl =
  process.env.NEXT_PUBLIC_SHOP_API_URL?.replace(/\/+$/, "") ??
  "http://localhost:3001";

export const api = hc<AppType>(baseUrl, {
  // Server Components run on Node; Client Components run in the browser. Both
  // use global fetch under the hood. Hono RPC will pick up Next's caching by
  // default — we override per call when we need different semantics.
  init: {
    headers: {
      // Lets us correlate frontend → API logs by the same id during debugging.
      // Server Components have no access to a request id at this layer, so
      // we omit. Future enhancement: use Next 16's `headers()` to forward
      // the incoming X-Request-Id from the user's browser.
      Accept: "application/json",
    },
  },
});

/** Convenience: fetch a page of products. Used from Server Components. */
export async function fetchProducts(query: {
  categorySlug?: string;
  inStock?: boolean;
  q?: string;
  sort?: "featured" | "newest" | "price_asc" | "price_desc";
  limit?: number;
  cursor?: string;
}) {
  // Hono's RPC client serialises booleans/numbers to strings automatically.
  const res = await api.products.$get(
    { query },
    {
      // Cache on the Next.js server for the same window as the API's CDN
      // hint — the API is the source of truth, but Next.js can short-circuit
      // duplicate requests within a render.
      init: { next: { revalidate: 300, tags: ["products"] } },
    },
  );
  if (!res.ok) {
    throw new ApiClientError(
      `GET /products failed (${res.status})`,
      res.status,
      await safeProblem(res),
    );
  }
  return res.json();
}

/**
 * Convenience: fetch the full category tree. Used by every storefront surface
 * that needs the navigation menu, the homepage categories grid, etc.
 *
 * Tag-based revalidation: when an admin edits the tree (later slice), the
 * server action that performs the edit will call
 * `revalidateTag('categories')` to purge this fetch's Next.js cache entry
 * regardless of how stale the in-memory copy is.
 */
export async function fetchCategoryTree() {
  const res = await api.categories.$get(
    {},
    { init: { next: { revalidate: 300, tags: ["categories"] } } },
  );
  if (!res.ok) {
    throw new ApiClientError(
      `GET /categories failed (${res.status})`,
      res.status,
      await safeProblem(res),
    );
  }
  return res.json();
}

/** Convenience: fetch a single product by slug. Returns null on 404. */
export async function fetchProductBySlug(slug: string) {
  const res = await api.products[":slug"].$get(
    { param: { slug } },
    { init: { next: { revalidate: 300, tags: ["products", `product:${slug}`] } } },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new ApiClientError(
      `GET /products/${slug} failed (${res.status})`,
      res.status,
      await safeProblem(res),
    );
  }
  return res.json();
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
