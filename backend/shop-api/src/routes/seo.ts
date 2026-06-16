import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { schema } from "@shop/db";
import { isNull } from "drizzle-orm";
import {
  ancestorSlugChain,
  categoryUrlFromChain,
  type CatRow,
} from "../lib/category-tree.js";
import { getDb } from "../lib/db.js";
import { notFound, ProblemSchema } from "../lib/errors.js";
import {
  resolveRedirectChain,
  type RedirectRow,
} from "../lib/redirect-resolve.js";
import { buildSitemapEntries } from "../lib/sitemap.js";
import { validationHook } from "../lib/validation-hook.js";

/**
 * SEO / crawlability surface — anonymous, read-only, public by design (no
 * `currentUser`, like `/products` and `/categories`). Two endpoints:
 *
 *   - `GET /redirects/resolve?path=…` — resolves a deleted URL to its 301 target
 *     (the serving half of the category cascade-delete's `redirects` rows). The
 *     storefront catch-all calls it on the would-be-404 path.
 *   - `GET /sitemap` — canonical paths + accurate `lastmod` for every live
 *     category and product, consumed by the storefront `app/sitemap.ts`.
 *
 * Neither lives in the Next.js proxy: the proxy is deliberately thin (no DB/API
 * calls — it runs on every navigation). Serving redirects only on the rare
 * would-be-404 keeps the happy path free, and the sitemap is generated on a
 * revalidation schedule, not per request.
 */

// ─── /sitemap DTOs ───────────────────────────────────────────────────────────

const SitemapEntrySchema = z
  .object({
    path: z.string().openapi({ example: "/products/elektronika/telefon" }),
    lastModified: z.string().openapi({ example: "2026-06-16T10:00:00.000Z" }),
  })
  .openapi("SitemapEntry");

const SitemapResponseSchema = z
  .object({
    categories: z.array(SitemapEntrySchema),
    products: z.array(SitemapEntrySchema),
    generatedAt: z.string(),
  })
  .openapi("SitemapResponse");

export type SitemapResponse = z.infer<typeof SitemapResponseSchema>;

// ─── /redirects/resolve DTOs ─────────────────────────────────────────────────

const RedirectResolveQuerySchema = z.object({
  path: z
    .string()
    .min(1)
    .max(2048)
    .refine((p) => p.startsWith("/"), {
      message: "path must be absolute (start with '/')",
    })
    .openapi({
      param: { name: "path", in: "query" },
      example: "/products/elektronika/star-telefon",
    }),
});

const RedirectResolutionSchema = z
  .object({
    target: z.string().openapi({ example: "/products/elektronika" }),
    statusCode: z
      .number()
      .int()
      .openapi({ example: 301, description: "301 | 302 | 307 | 308" }),
  })
  .openapi("RedirectResolution");

export type RedirectResolution = z.infer<typeof RedirectResolutionSchema>;

// ─── Cache headers ───────────────────────────────────────────────────────────

const SITEMAP_CACHE_HEADERS = {
  // Catalog changes are infrequent; an hour at the edge with a short stale
  // window is plenty. The storefront sitemap.ts also revalidates hourly.
  "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=300",
  Vary: "Accept-Encoding",
};

const REDIRECT_CACHE_HEADERS = {
  // A resolution is stable until another delete extends the chain — 5 min edge
  // cache matches the categories endpoint and keeps the would-be-404 path cheap.
  "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=60",
  Vary: "Accept-Encoding",
};

// ─── Route definitions ───────────────────────────────────────────────────────

const sitemapRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["seo"],
  summary: "Sitemap source data (live categories + products with lastmod)",
  description:
    "Every non-deleted category and product as a canonical storefront path with " +
    "its real last-modified timestamp. Source of truth for the storefront " +
    "`/sitemap.xml`. Cached 1h at the edge.",
  responses: {
    200: {
      description: "Canonical paths + lastmod for the live catalog.",
      content: { "application/json": { schema: SitemapResponseSchema } },
    },
  },
});

const resolveRedirectRoute = createRoute({
  method: "get",
  path: "/resolve",
  tags: ["seo"],
  summary: "Resolve a deleted URL to its 301 redirect target",
  description:
    "Looks up `path` in the redirects table (written by the admin category " +
    "cascade-delete) and follows any chain to the final surviving target. " +
    "Returns 404 when no redirect exists for the path.",
  request: { query: RedirectResolveQuerySchema },
  responses: {
    200: {
      description: "The final redirect target + status code.",
      content: { "application/json": { schema: RedirectResolutionSchema } },
    },
    400: {
      description: "Invalid query parameters.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    404: {
      description: "No redirect is registered for this path.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

// ─── Routers ─────────────────────────────────────────────────────────────────

export const sitemapRoutes = new OpenAPIHono({ defaultHook: validationHook });

sitemapRoutes.openapi(sitemapRoute, async (c) => {
  const db = getDb();

  // One query each — at this catalog size (a few dozen categories, well under the
  // §16.3 20K-SKU search threshold) a flat SELECT is faster than anything fancy.
  const [cats, prods] = await Promise.all([
    db
      .select({
        id: schema.categories.id,
        slug: schema.categories.slug,
        name: schema.categories.name,
        parentId: schema.categories.parentId,
        updatedAt: schema.categories.updatedAt,
      })
      .from(schema.categories)
      .where(isNull(schema.categories.deletedAt)),
    db
      .select({
        slug: schema.products.slug,
        categoryId: schema.products.categoryId,
        updatedAt: schema.products.updatedAt,
      })
      .from(schema.products)
      .where(isNull(schema.products.deletedAt)),
  ]);

  const { categories, products } = buildSitemapEntries(cats, prods);

  return c.json(
    {
      categories: categories.map((e) => ({
        path: e.path,
        lastModified: e.lastModified.toISOString(),
      })),
      products: products.map((e) => ({
        path: e.path,
        lastModified: e.lastModified.toISOString(),
      })),
      generatedAt: new Date().toISOString(),
    },
    200,
    SITEMAP_CACHE_HEADERS,
  );
});

export const redirectsRoutes = new OpenAPIHono({ defaultHook: validationHook });

redirectsRoutes.openapi(resolveRedirectRoute, async (c) => {
  const { path } = c.req.valid("query");
  const db = getDb();

  // Load every redirect once into a Map and every category once into an id→URL
  // map, then resolve synchronously with the pure resolver. "Load all" is correct
  // at this scale: the redirects table only grows on the rare admin delete and
  // stays small. If it ever exceeds ~10K rows, switch to iterative indexed
  // lookups on the UNIQUE `source_path` (one query per hop, ≤ REDIRECT_MAX_HOPS).
  const [redirectRows, catRows] = await Promise.all([
    db
      .select({
        sourcePath: schema.redirects.sourcePath,
        targetKind: schema.redirects.targetKind,
        targetCategoryId: schema.redirects.targetCategoryId,
        targetProductId: schema.redirects.targetProductId,
        statusCode: schema.redirects.statusCode,
      })
      .from(schema.redirects),
    // Include soft-deleted categories: an intermediate target in a chain may have
    // been deleted since, and we still need to reconstruct its old URL to follow
    // the next hop. A surviving target's chain is identical either way.
    db
      .select({
        id: schema.categories.id,
        slug: schema.categories.slug,
        name: schema.categories.name,
        parentId: schema.categories.parentId,
      })
      .from(schema.categories),
  ]);

  const redirectByPath = new Map<string, RedirectRow>();
  for (const r of redirectRows) {
    redirectByPath.set(r.sourcePath, {
      targetKind: r.targetKind,
      targetCategoryId: r.targetCategoryId,
      targetProductId: r.targetProductId,
      statusCode: r.statusCode,
    });
  }

  const allCats: CatRow[] = catRows;
  const categoryUrlById = (id: string): string | null => {
    const chain = ancestorSlugChain(allCats, id);
    return chain ? categoryUrlFromChain(chain) : null;
  };

  const resolved = resolveRedirectChain({
    requestedPath: path,
    lookupRedirect: (p) => redirectByPath.get(p),
    categoryUrlById,
  });

  if (!resolved) {
    throw notFound(`No redirect registered for ${path}`);
  }

  return c.json(
    { target: resolved.target, statusCode: resolved.statusCode },
    200,
    REDIRECT_CACHE_HEADERS,
  );
});
