import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { schema } from "@shop/db";
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { decodeCursor, encodeCursor, type CursorPayload } from "../lib/cursor.js";
import { getDb } from "../lib/db.js";
import { ProblemSchema, badRequest, notFound } from "../lib/errors.js";
import { buildImageUrl } from "../lib/images.js";
import { validationHook } from "../lib/validation-hook.js";

// ─── Public DTOs (OpenAPI-aware) ───────────────────────────────────────────

const ProductImageSchema = z
  .object({
    id: z.string().uuid(),
    url: z.string().url(),
    alt: z.string(),
    displayOrder: z.number().int(),
  })
  .openapi("ProductImage");

const StockStatusSchema = z.enum(["in_stock", "out_of_stock"]).openapi("StockStatus");

/**
 * priceCents is intentionally a NUMBER, not a string. Postgres returns
 * numeric as a string for precision; we convert to a number once at the API
 * edge because the product price domain is bounded (numeric(10,0) →
 * 0 ≤ x ≤ 9_999_999_999, well within Number.MAX_SAFE_INTEGER).
 *
 * The frontend then renders `priceCents / 100` formatted as currency.
 */
const ProductSummarySchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    code: z.string(),
    name: z.string(),
    priceCents: z.number().int().nonnegative(),
    currency: z.string(),
    stockStatus: StockStatusSchema,
    isNew: z.boolean(),
    primaryImage: ProductImageSchema.nullable(),
  })
  .openapi("ProductSummary");

const CategoryBreadcrumbSchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    name: z.string(),
  })
  .openapi("CategoryBreadcrumb");

const ProductDetailSchema = ProductSummarySchema.extend({
  description: z.string(),
  images: z.array(ProductImageSchema),
  breadcrumb: z.array(CategoryBreadcrumbSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
}).openapi("ProductDetail");

const ProductsPageSchema = z
  .object({
    items: z.array(ProductSummarySchema),
    nextCursor: z.string().nullable(),
    /**
     * Total is intentionally absent. Cursor pagination doesn't compute a count,
     * and providing one would force a separate full-table scan that defeats
     * the whole point. UIs that need a count can ask /products/_count.
     */
  })
  .openapi("ProductsPage");

/**
 * Public DTO types — re-exported from `src/types.ts` and consumed by the
 * frontend without going through the Hono RPC `AppType` ReturnType chain.
 *
 * The `AppType` route does work over the workspace symlink in most local
 * setups, but `ReturnType<typeof buildApp>` walks a deep dependency graph
 * (every route file, every Zod schema, every workspace dep) and degrades
 * to `any` if ANY link breaks. The explicit Zod-inferred types below are
 * resilient — they only depend on this file and Zod's own type machinery,
 * so consumers always get the right shape.
 */
export type ProductImage = z.infer<typeof ProductImageSchema>;
export type StockStatus = z.infer<typeof StockStatusSchema>;
export type ProductSummary = z.infer<typeof ProductSummarySchema>;
export type CategoryBreadcrumb = z.infer<typeof CategoryBreadcrumbSchema>;
export type ProductDetail = z.infer<typeof ProductDetailSchema>;
export type ProductsPage = z.infer<typeof ProductsPageSchema>;

// ─── Query schemas ─────────────────────────────────────────────────────────

const SortKey = z.enum(["featured", "newest", "price_asc", "price_desc"]);

const ListQuerySchema = z.object({
  categorySlug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/, "must be a slug")
    .optional()
    .openapi({ description: "Limit results to a single category." }),
  inStock: z
    .preprocess(
      (v) => (v === "true" ? true : v === "false" ? false : v),
      z.boolean(),
    )
    .optional()
    .openapi({ description: "When true, exclude out-of-stock products." }),
  q: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .optional()
    .openapi({ description: "Free-text query over product name and code (ILIKE)." }),
  sort: SortKey.default("featured").openapi({ description: "Result ordering." }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(60)
    .default(24)
    .openapi({ description: "Page size (max 60)." }),
  cursor: z
    .string()
    .min(1)
    .max(2000)
    .optional()
    .openapi({ description: "Opaque cursor returned by a previous response." }),
});

const SlugParamsSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9-]+$/, "must be a slug")
    .openapi({ param: { in: "path", name: "slug" }, example: "samsung-galaxy-a55" }),
});

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * `numeric` columns come back as strings from node-postgres because JS numbers
 * cannot losslessly hold all values of an arbitrary-precision NUMERIC. Our
 * priceCents domain is bounded by the schema (numeric(10,0)), so coercion is
 * safe — but we ALWAYS run it through Number() at the API boundary, never
 * inline arithmetic on the string.
 */
function toCents(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number.parseInt(v, 10);
  throw new Error(`Unexpected priceCents type: ${typeof v}`);
}

function isProductNew(newUntil: Date | null | undefined): boolean {
  return newUntil !== null && newUntil !== undefined && newUntil.getTime() > Date.now();
}

const SHARED_CACHE_HEADERS = {
  // Catalog is slow-moving for browsers, fast-moving for ops. CloudFront caches
  // for 5 minutes (s-maxage), serves stale for up to 1 minute while it fetches
  // a fresh copy in the background. Browsers always revalidate (max-age=0) so
  // they pick up admin edits instantly via the ETag handshake.
  "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=60",
  Vary: "Accept-Encoding",
};

// ─── Route definitions ─────────────────────────────────────────────────────

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["products"],
  summary: "List products",
  request: { query: ListQuerySchema },
  responses: {
    200: {
      description: "A page of products.",
      content: { "application/json": { schema: ProductsPageSchema } },
    },
    400: {
      description: "Invalid query parameters.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

const detailRoute = createRoute({
  method: "get",
  path: "/{slug}",
  tags: ["products"],
  summary: "Get a single product by slug",
  request: { params: SlugParamsSchema },
  responses: {
    200: {
      description: "The product.",
      content: { "application/json": { schema: ProductDetailSchema } },
    },
    404: {
      description: "No product with that slug (or it was deleted).",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

// ─── Router ────────────────────────────────────────────────────────────────

/**
 * Sub-router. The parent app supplies `requestId` and `logger` on the context;
 * we don't need them here, but typing the variables matches the parent so
 * `app.route("/products", productsRoutes)` doesn't widen the context shape.
 *
 * IMPORTANT: `defaultHook` must be set on every OpenAPIHono instance whose
 * routes use validation — it does NOT inherit from the parent app on mount.
 * Without this, validation failures here fall through to the library's
 * stock `{success: false, error: {...}}` JSON response and our RFC 9457
 * contract is silently violated.
 */
export const productsRoutes = new OpenAPIHono({
  defaultHook: validationHook,
});


productsRoutes.openapi(listRoute, async (c) => {
  const db = getDb();
  const q = c.req.valid("query");

  // 1. Resolve categorySlug → categoryId (single-category match — recursive
  //    descent into subcategories is intentionally deferred to a later slice).
  let categoryId: string | undefined;
  if (q.categorySlug) {
    const [cat] = await db
      .select({ id: schema.categories.id })
      .from(schema.categories)
      .where(
        and(
          eq(schema.categories.slug, q.categorySlug),
          isNull(schema.categories.deletedAt),
        ),
      )
      .limit(1);
    if (!cat) {
      // Empty page on unknown category — feels gentler than 404 for a query.
      return c.json(
        { items: [], nextCursor: null },
        200,
        SHARED_CACHE_HEADERS,
      );
    }
    categoryId = cat.id;
  }

  // 2. Decode cursor if present and verify it matches the current sort.
  let cursor: CursorPayload | null = null;
  if (q.cursor) {
    cursor = decodeCursor(q.cursor);
    if (!cursor || cursor.s[0] !== q.sort) {
      throw badRequest("Cursor is invalid for the current sort.");
    }
  }

  // 3. Build WHERE clause.
  const whereParts = [isNull(schema.products.deletedAt)];
  if (categoryId) whereParts.push(eq(schema.products.categoryId, categoryId));
  if (q.inStock) whereParts.push(eq(schema.products.stockStatus, "in_stock"));
  if (q.q) {
    const pattern = `%${q.q}%`;
    whereParts.push(
      or(
        ilike(schema.products.name, pattern),
        ilike(schema.products.code, pattern),
      )!,
    );
  }

  // 4. Cursor predicate. The "row is strictly past the cursor" check varies
  //    per sort — we always include id as a tiebreaker for total ordering.
  if (cursor) {
    const [, sortVal, lastId] = cursor.s;
    if (q.sort === "newest") {
      // ORDER BY created_at DESC, id DESC → "past" means smaller (older) tuples.
      whereParts.push(
        sql`(${schema.products.createdAt}, ${schema.products.id}) < (${sortVal as string}::timestamptz, ${lastId}::uuid)`,
      );
    } else if (q.sort === "price_asc") {
      whereParts.push(
        sql`(${schema.products.priceCents}, ${schema.products.id}) > (${sortVal as string}::numeric, ${lastId}::uuid)`,
      );
    } else if (q.sort === "price_desc") {
      whereParts.push(
        sql`(${schema.products.priceCents}, ${schema.products.id}) < (${sortVal as string}::numeric, ${lastId}::uuid)`,
      );
    } else if (q.sort === "featured") {
      whereParts.push(
        sql`(${schema.products.displayOrder}, ${schema.products.id}) > (${sortVal as number}::int, ${lastId}::uuid)`,
      );
    }
  }

  // 5. ORDER BY. The id tiebreaker keeps the order total even for ties on the
  //    primary sort key.
  const orderBy =
    q.sort === "newest"
      ? [desc(schema.products.createdAt), desc(schema.products.id)]
      : q.sort === "price_asc"
        ? [asc(schema.products.priceCents), asc(schema.products.id)]
        : q.sort === "price_desc"
          ? [desc(schema.products.priceCents), desc(schema.products.id)]
          : [asc(schema.products.displayOrder), asc(schema.products.id)];

  // 6. Fetch limit+1 to detect "is there a next page".
  const fetched = await db
    .select({
      id: schema.products.id,
      slug: schema.products.slug,
      code: schema.products.code,
      name: schema.products.name,
      priceCents: schema.products.priceCents,
      currency: schema.products.currency,
      stockStatus: schema.products.stockStatus,
      newUntil: schema.products.newUntil,
      displayOrder: schema.products.displayOrder,
      createdAt: schema.products.createdAt,
    })
    .from(schema.products)
    .where(and(...whereParts))
    .orderBy(...orderBy)
    .limit(q.limit + 1);

  const hasMore = fetched.length > q.limit;
  const pageRows = hasMore ? fetched.slice(0, q.limit) : fetched;

  // 7. Pull primary image (lowest displayOrder) per product in one query.
  const primaryImagesByProduct = new Map<
    string,
    { id: string; url: string; alt: string; displayOrder: number }
  >();
  if (pageRows.length > 0) {
    const ids = pageRows.map((r) => r.id);
    const images = await db
      .select({
        id: schema.productImages.id,
        productId: schema.productImages.productId,
        s3Key: schema.productImages.s3Key,
        altText: schema.productImages.altText,
        displayOrder: schema.productImages.displayOrder,
      })
      .from(schema.productImages)
      .where(inArray(schema.productImages.productId, ids))
      .orderBy(asc(schema.productImages.displayOrder), asc(schema.productImages.id));
    for (const img of images) {
      if (!primaryImagesByProduct.has(img.productId)) {
        primaryImagesByProduct.set(img.productId, {
          id: img.id,
          url: buildImageUrl(img.s3Key),
          alt: img.altText,
          displayOrder: img.displayOrder,
        });
      }
    }
  }

  const items = pageRows.map((p) => ({
    id: p.id,
    slug: p.slug,
    code: p.code,
    name: p.name,
    priceCents: toCents(p.priceCents),
    currency: p.currency,
    stockStatus: p.stockStatus,
    isNew: isProductNew(p.newUntil),
    primaryImage: primaryImagesByProduct.get(p.id) ?? null,
  }));

  let nextCursor: string | null = null;
  if (hasMore) {
    const last = pageRows[pageRows.length - 1]!;
    if (q.sort === "newest") {
      nextCursor = encodeCursor({
        k: "products_v1",
        s: ["newest", last.createdAt.toISOString(), last.id],
      });
    } else if (q.sort === "price_asc") {
      nextCursor = encodeCursor({
        k: "products_v1",
        s: ["price_asc", String(toCents(last.priceCents)), last.id],
      });
    } else if (q.sort === "price_desc") {
      nextCursor = encodeCursor({
        k: "products_v1",
        s: ["price_desc", String(toCents(last.priceCents)), last.id],
      });
    } else {
      nextCursor = encodeCursor({
        k: "products_v1",
        s: ["featured", last.displayOrder, last.id],
      });
    }
  }

  return c.json({ items, nextCursor }, 200, SHARED_CACHE_HEADERS);
});

productsRoutes.openapi(detailRoute, async (c) => {
  const db = getDb();
  const { slug } = c.req.valid("param");

  const [product] = await db
    .select()
    .from(schema.products)
    .where(
      and(eq(schema.products.slug, slug), isNull(schema.products.deletedAt)),
    )
    .limit(1);

  if (!product) {
    throw notFound(`No product with slug "${slug}".`);
  }

  // Fetch all images, ordered.
  const images = await db
    .select()
    .from(schema.productImages)
    .where(eq(schema.productImages.productId, product.id))
    .orderBy(asc(schema.productImages.displayOrder), asc(schema.productImages.id));

  // Walk the category breadcrumb. Recursive CTE so we get the whole chain in
  // one round-trip, ordered root → leaf.
  let breadcrumb: { id: string; slug: string; name: string }[] = [];
  if (product.categoryId) {
    const rows = await db.execute<{
      id: string;
      slug: string;
      name: string;
      depth: number;
    }>(sql`
      WITH RECURSIVE chain AS (
        SELECT id, slug, name, parent_id, 0 AS depth
          FROM categories
          WHERE id = ${product.categoryId} AND deleted_at IS NULL
        UNION ALL
        SELECT c.id, c.slug, c.name, c.parent_id, chain.depth + 1
          FROM categories c
          JOIN chain ON c.id = chain.parent_id
          WHERE c.deleted_at IS NULL
      )
      SELECT id, slug, name, depth FROM chain ORDER BY depth DESC
    `);
    const allRows = (rows as unknown as { rows: { id: string; slug: string; name: string }[] }).rows
      ?? (rows as unknown as { id: string; slug: string; name: string }[]);
    breadcrumb = allRows.map((r) => ({ id: r.id, slug: r.slug, name: r.name }));
  }

  const detail = {
    id: product.id,
    slug: product.slug,
    code: product.code,
    name: product.name,
    description: product.description,
    priceCents: toCents(product.priceCents),
    currency: product.currency,
    stockStatus: product.stockStatus,
    isNew: isProductNew(product.newUntil),
    primaryImage:
      images[0]
        ? {
            id: images[0].id,
            url: buildImageUrl(images[0].s3Key),
            alt: images[0].altText,
            displayOrder: images[0].displayOrder,
          }
        : null,
    images: images.map((i) => ({
      id: i.id,
      url: buildImageUrl(i.s3Key),
      alt: i.altText,
      displayOrder: i.displayOrder,
    })),
    breadcrumb,
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
  };

  return c.json(detail, 200, SHARED_CACHE_HEADERS);
});
