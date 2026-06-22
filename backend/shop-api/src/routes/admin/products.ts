import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { schema } from "@shop/db";
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Logger } from "pino";
import {
  ACTIVE_ORDER_STATUSES_FOR_DELETION,
  ancestorSlugChain,
  type CatRow,
} from "../../lib/category-tree.js";
import { getDb } from "../../lib/db.js";
import { ApiError, ProblemSchema, badRequest, notFound } from "../../lib/errors.js";
import { buildImageUrl } from "../../lib/images.js";
import { logger as baseLogger } from "../../lib/logger.js";
import {
  MAX_PRODUCT_IMAGES,
  defaultNewUntil,
  normalizeImages,
  productCanonicalPath,
  resolveNewUntil,
  resolveProductSlug,
} from "../../lib/product-admin.js";
import { validationHook } from "../../lib/validation-hook.js";
import { requireAdmin } from "../../middleware/admin.js";
import type { AuthVariables } from "../../middleware/auth.js";

/**
 * Admin product management — the third admin CRUD slice (the admin CRUD
 * surface is docs/ARCHITECTURE.md §15 item 22; docs/README.md §"Управление на
 * продукти"). Follows the orders (2026-06-10) and categories (2026-06-15)
 * slices.
 *
 * Surface (all behind `requireAdmin` — non-admins get the uniform 404):
 *
 *   GET    /admin/products            offset-paginated list + filters + search
 *   POST   /admin/products            create (appended to the end of its category)
 *   POST   /admin/products/reorder    rewrite one category's product display order
 *   GET    /admin/products/:id        full detail (incl. archived) + image set
 *   PATCH  /admin/products/:id         edit / move / re-image (optimistic-locked)
 *   DELETE /admin/products/:id         soft-delete + 301 redirect to its category
 *   POST   /admin/products/:id/restore un-archive (clears the redirect)
 *
 * Design notes (researched against 2026 practice — see ARCHITECTURE §13):
 *
 *   - **Single-SKU model, no variant matrix.** One `code` (SKU) per product.
 *     For a small catalog that is the correct, simplest shape; a
 *     `product_variants` child table is a documented future door (§16),
 *     opened only on a real size/colour requirement.
 *   - **Optimistic locking WITHOUT a `version` column** — identical to the
 *     categories slice. Mutating endpoints take the `updatedAt` the admin's
 *     screen rendered from as `expectedUpdatedAt`; the handler re-reads the row
 *     `FOR UPDATE` inside the transaction and compares in JS at millisecond
 *     precision before writing (the row lock makes read-compare-write atomic;
 *     comparing the driver-truncated `Date` sidesteps the Postgres-microsecond
 *     vs JS-millisecond equality pitfall a `WHERE updated_at = $1` guard hits).
 *   - **Uniqueness spans soft-deleted rows.** `products_slug_unique` and
 *     `products_code_unique` are non-partial indexes (they cover archived rows),
 *     so the slug/code checks here query ALL rows, not just live ones — a clean
 *     409 instead of a surprise DB constraint 500, and the right behaviour for
 *     SEO (a soft-deleted slug still 301s away) and for treating the SKU as a
 *     stable identifier. To reuse an archived product's slug/code, restore it.
 *   - **Soft-delete + 301 redirect**, mirroring the category cascade. Deleting a
 *     product soft-deletes it (`deleted_at`) and writes a `redirects` row from
 *     its canonical URL to its category (or home), so old links 301 instead of
 *     turning into soft-404s. Order history is untouched — `order_items` carry
 *     their own snapshot. Restore clears `deleted_at` AND removes that redirect.
 *   - **Images by S3 key.** Create/PATCH accept an ordered image list of
 *     `{ s3Key, altText }`; the public URL is derived at the edge via
 *     `buildImageUrl` (CloudFront in front of a private bucket). This is exactly
 *     the categories slice's image convention. The actual file UPLOAD pipeline
 *     (presigned direct-to-S3 POST with a content-type allowlist +
 *     content-length-range + a PutObject magic-byte validation Lambda + the
 *     bucket/CDN Terraform) is a separate, infra-bearing slice that will serve
 *     products, categories and banners uniformly — a documented next step
 *     (ARCHITECTURE §15 item 22 "what remains").
 *   - **Audit trail.** Every state change appends to `admin_audit_log`
 *     (GDPR Art. 30) in the same transaction as the write.
 */

type AdminProductsVariables = AuthVariables & {
  logger: Logger;
  requestId: string;
};

export const adminProductsRoutes = new OpenAPIHono<{
  Variables: AdminProductsVariables;
}>({
  defaultHook: validationHook,
});

// currentUser is applied in app.ts (it resolves the cookie); requireAdmin turns
// everything below into a flat 404 for non-admins — uniform with the rest of
// the admin surface, so it stays unconfirmable.
adminProductsRoutes.use("*", requireAdmin);

// ─── DTOs ────────────────────────────────────────────────────────────────────

// NB: a distinct OpenAPI component name from the public products route's
// "StockStatus" — the shared registry rejects two different schema instances
// under one name when `app.doc("/openapi.json")` builds the spec.
const StockStatusSchema = z.enum(["in_stock", "out_of_stock"]).openapi("AdminStockStatus");

const AdminProductImageSchema = z
  .object({
    id: z.string().uuid(),
    s3Key: z.string(),
    url: z.string().url(),
    alt: z.string(),
    displayOrder: z.number().int(),
  })
  .openapi("AdminProductImage");

const AdminProductSummarySchema = z
  .object({
    id: z.string().uuid(),
    code: z.string(),
    slug: z.string(),
    name: z.string(),
    priceCents: z.number().int().nonnegative(),
    currency: z.string(),
    stockStatus: StockStatusSchema,
    isNew: z.boolean(),
    categoryId: z.string().uuid().nullable(),
    categoryName: z.string().nullable(),
    primaryImageUrl: z.string().url().nullable(),
    imageCount: z.number().int(),
    displayOrder: z.number().int(),
    archived: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("AdminProductSummary");

export type AdminProductSummary = z.infer<typeof AdminProductSummarySchema>;

const CategoryCrumbSchema = z
  .object({ id: z.string().uuid(), slug: z.string(), name: z.string() })
  .openapi("AdminProductCategoryCrumb");

const AdminProductDetailSchema = AdminProductSummarySchema.extend({
  description: z.string(),
  newUntil: z.string().nullable(),
  images: z.array(AdminProductImageSchema),
  breadcrumb: z.array(CategoryCrumbSchema),
  /** Of this product, how many active orders reference it (delete warning). */
  activeOrderCount: z.number().int(),
  deletedAt: z.string().nullable(),
}).openapi("AdminProductDetail");

export type AdminProductDetail = z.infer<typeof AdminProductDetailSchema>;

const AdminProductListSchema = z
  .object({
    items: z.array(AdminProductSummarySchema),
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
    totalPages: z.number().int(),
  })
  .openapi("AdminProductList");

export type AdminProductList = z.infer<typeof AdminProductListSchema>;

const slugField = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .openapi({ description: "Lowercase latin letters, digits and hyphens." });

const codeField = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "SKU: letters, digits, '.', '_', '-'");

const imageInputSchema = z.object({
  s3Key: z.string().trim().min(1).max(500),
  altText: z.string().max(300).optional(),
});

const priceField = z
  .number()
  .int("Price must be an integer number of cents.")
  .nonnegative()
  .max(9_999_999_999);

const currencyField = z
  .string()
  .trim()
  .length(3)
  .regex(/^[A-Z]{3}$/, "ISO 4217 3-letter code")
  .openapi({ example: "EUR" });

const CreateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    code: codeField,
    /** Optional — derived from `name` (Bulgarian→Latin) when omitted. */
    slug: slugField.optional(),
    description: z.string().max(5000).optional(),
    priceCents: priceField,
    currency: currencyField.optional(),
    /** null / omitted = uncategorised. */
    categoryId: z.string().uuid().nullable().optional(),
    stockStatus: StockStatusSchema.optional(),
    /**
     * Controls the "NEW" badge: omit → defaults to 30 days from now; `null` →
     * no badge; an ISO-8601 instant → lit until then.
     */
    newUntil: z.string().nullable().optional(),
    images: z.array(imageInputSchema).max(MAX_PRODUCT_IMAGES).optional(),
  })
  .strict()
  .openapi("AdminProductCreateRequest");

const UpdateRequestSchema = z
  .object({
    /** The `updatedAt` the screen rendered from (optimistic lock). */
    expectedUpdatedAt: z.string().min(1),
    name: z.string().trim().min(1).max(200).optional(),
    code: codeField.optional(),
    slug: slugField.optional(),
    description: z.string().max(5000).optional(),
    priceCents: priceField.optional(),
    currency: currencyField.optional(),
    /** Present = move. `null` makes it uncategorised; a uuid moves it there. */
    categoryId: z.string().uuid().nullable().optional(),
    stockStatus: StockStatusSchema.optional(),
    newUntil: z.string().nullable().optional(),
    /** Present = replace the whole image set (ordered); `[]` clears it. */
    images: z.array(imageInputSchema).max(MAX_PRODUCT_IMAGES).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    const { expectedUpdatedAt: _ignored, ...rest } = val;
    if (Object.values(rest).every((v) => v === undefined)) {
      ctx.addIssue({ code: "custom", message: "At least one field to update is required." });
    }
  })
  .openapi("AdminProductUpdateRequest");

const ReorderRequestSchema = z
  .object({
    /** The category layer being reordered. null = the uncategorised layer. */
    categoryId: z.string().uuid().nullable(),
    /** The product ids in their new order — must be exactly that layer's set. */
    orderedIds: z.array(z.string().uuid()).min(1),
  })
  .strict()
  .openapi("AdminProductReorderRequest");

const DeleteRequestSchema = z
  .object({
    expectedUpdatedAt: z.string().min(1),
    /** The spec's „Разбирам последствията" checkbox — must be explicitly true. */
    confirmConsequences: z.literal(true),
  })
  .strict()
  .openapi("AdminProductDeleteRequest");

const ParamId = z.object({
  id: z.string().uuid().openapi({ param: { name: "id", in: "path" } }),
});

// ─── Problem builders ─────────────────────────────────────────────────────────

function productNotFound(id: string): ApiError {
  return notFound(`No product with id ${id}.`, "/problems/product-not-found");
}

function versionConflict(id: string): ApiError {
  return new ApiError({
    type: "/problems/product-version-conflict",
    title: "Product Was Updated Concurrently",
    status: 409,
    detail: `Product ${id} changed since your screen loaded. Reload and retry.`,
  });
}

function slugConflict(slug: string): ApiError {
  return new ApiError({
    type: "/problems/product-slug-conflict",
    title: "Slug Already In Use",
    status: 409,
    detail: `A product with slug "${slug}" already exists (it may be archived — restore it instead of recreating).`,
  });
}

function codeConflict(code: string): ApiError {
  return new ApiError({
    type: "/problems/product-code-conflict",
    title: "SKU Already In Use",
    status: 409,
    detail: `A product with SKU "${code}" already exists (it may be archived — restore it instead of recreating).`,
  });
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

function toCents(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number.parseInt(v, 10);
  throw new Error(`Unexpected priceCents type: ${typeof v}`);
}

function isProductNew(newUntil: Date | null | undefined): boolean {
  return newUntil != null && newUntil.getTime() > Date.now();
}

function clientUserAgent(c: {
  req: { header: (n: string) => string | undefined };
}): string | null {
  return c.req.header("user-agent") ?? null;
}

/** All LIVE categories as the flat shape `ancestorSlugChain` needs. */
async function loadLiveCatRows(db: ReturnType<typeof getDb>): Promise<CatRow[]> {
  const rows = await db
    .select({
      id: schema.categories.id,
      slug: schema.categories.slug,
      name: schema.categories.name,
      parentId: schema.categories.parentId,
    })
    .from(schema.categories)
    .where(isNull(schema.categories.deletedAt));
  return rows.map((r) => ({ id: r.id, slug: r.slug, name: r.name, parentId: r.parentId }));
}

/** True when ANY product (incl. soft-deleted) already uses `slug`, excluding self. */
async function slugTaken(
  db: ReturnType<typeof getDb>,
  slug: string,
  excludeId?: string,
): Promise<boolean> {
  const conds = [eq(schema.products.slug, slug)];
  if (excludeId) conds.push(sql`${schema.products.id} <> ${excludeId}`);
  const [hit] = await db
    .select({ id: schema.products.id })
    .from(schema.products)
    .where(and(...conds))
    .limit(1);
  return Boolean(hit);
}

/** True when ANY product (incl. soft-deleted) already uses `code`, excluding self. */
async function codeTaken(
  db: ReturnType<typeof getDb>,
  code: string,
  excludeId?: string,
): Promise<boolean> {
  const conds = [eq(schema.products.code, code)];
  if (excludeId) conds.push(sql`${schema.products.id} <> ${excludeId}`);
  const [hit] = await db
    .select({ id: schema.products.id })
    .from(schema.products)
    .where(and(...conds))
    .limit(1);
  return Boolean(hit);
}

/** A LIVE category by id, or undefined. Used to validate create/move targets. */
async function liveCategory(
  db: ReturnType<typeof getDb>,
  id: string,
): Promise<{ id: string } | undefined> {
  const [row] = await db
    .select({ id: schema.categories.id })
    .from(schema.categories)
    .where(and(eq(schema.categories.id, id), isNull(schema.categories.deletedAt)))
    .limit(1);
  return row;
}

/** Count distinct ACTIVE orders that reference this product. */
async function activeOrderCountFor(
  db: ReturnType<typeof getDb>,
  productId: string,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(distinct ${schema.orders.id})::int` })
    .from(schema.orderItems)
    .innerJoin(schema.orders, eq(schema.orders.id, schema.orderItems.orderId))
    .where(
      and(
        eq(schema.orderItems.productId, productId),
        inArray(schema.orders.status, [...ACTIVE_ORDER_STATUSES_FOR_DELETION]),
      ),
    );
  return row?.n ?? 0;
}

/** Build the full detail DTO for a product id (includes archived rows). */
async function buildDetail(
  db: ReturnType<typeof getDb>,
  id: string,
): Promise<AdminProductDetail | null> {
  const [product] = await db
    .select()
    .from(schema.products)
    .where(eq(schema.products.id, id))
    .limit(1);
  if (!product) return null;

  const images = await db
    .select()
    .from(schema.productImages)
    .where(eq(schema.productImages.productId, id))
    .orderBy(asc(schema.productImages.displayOrder), asc(schema.productImages.id));

  let breadcrumb: { id: string; slug: string; name: string }[] = [];
  if (product.categoryId) {
    const rows = await db.execute<{ id: string; slug: string; name: string; depth: number }>(sql`
      WITH RECURSIVE chain AS (
        SELECT id, slug, name, parent_id, 0 AS depth
          FROM categories WHERE id = ${product.categoryId} AND deleted_at IS NULL
        UNION ALL
        SELECT c.id, c.slug, c.name, c.parent_id, chain.depth + 1
          FROM categories c JOIN chain ON c.id = chain.parent_id
          WHERE c.deleted_at IS NULL
      )
      SELECT id, slug, name, depth FROM chain ORDER BY depth DESC
    `);
    const allRows =
      (rows as unknown as { rows: { id: string; slug: string; name: string }[] }).rows ??
      (rows as unknown as { id: string; slug: string; name: string }[]);
    breadcrumb = allRows.map((r) => ({ id: r.id, slug: r.slug, name: r.name }));
  }

  const activeOrderCount = await activeOrderCountFor(db, id);
  const categoryName = breadcrumb.length > 0 ? breadcrumb[breadcrumb.length - 1]!.name : null;

  return {
    id: product.id,
    code: product.code,
    slug: product.slug,
    name: product.name,
    description: product.description,
    priceCents: toCents(product.priceCents),
    currency: product.currency,
    stockStatus: product.stockStatus,
    isNew: isProductNew(product.newUntil),
    newUntil: product.newUntil ? product.newUntil.toISOString() : null,
    categoryId: product.categoryId,
    categoryName,
    primaryImageUrl: images[0] ? buildImageUrl(images[0].s3Key) : null,
    imageCount: images.length,
    displayOrder: product.displayOrder,
    archived: product.deletedAt !== null,
    images: images.map((i) => ({
      id: i.id,
      s3Key: i.s3Key,
      url: buildImageUrl(i.s3Key),
      alt: i.altText,
      displayOrder: i.displayOrder,
    })),
    breadcrumb,
    activeOrderCount,
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
    deletedAt: product.deletedAt ? product.deletedAt.toISOString() : null,
  };
}

// ─── GET /admin/products ──────────────────────────────────────────────────────

const ListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(["active", "archived", "all"]).default("active"),
  categoryId: z.string().uuid().optional(),
  stockStatus: StockStatusSchema.optional(),
  q: z.string().trim().min(1).max(120).optional(),
  sort: z.enum(["newest", "oldest", "price_asc", "price_desc", "name"]).default("newest"),
});

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["admin-products"],
  summary: "List products (offset-paginated) with filters and search",
  request: { query: ListQuerySchema },
  responses: {
    200: {
      description: "A page of products.",
      content: { "application/json": { schema: AdminProductListSchema } },
    },
    404: {
      description: "No admin session (uniform with the rest of the surface).",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminProductsRoutes.openapi(listRoute, async (c) => {
  const db = getDb();
  const q = c.req.valid("query");

  const where: SQL[] = [];
  if (q.status === "active") where.push(isNull(schema.products.deletedAt));
  else if (q.status === "archived") where.push(sql`${schema.products.deletedAt} IS NOT NULL`);
  if (q.categoryId) where.push(eq(schema.products.categoryId, q.categoryId));
  if (q.stockStatus) where.push(eq(schema.products.stockStatus, q.stockStatus));
  if (q.q) {
    const pattern = `%${q.q}%`;
    where.push(or(ilike(schema.products.name, pattern), ilike(schema.products.code, pattern))!);
  }
  const whereClause = where.length > 0 ? and(...where) : undefined;

  const [{ total }] = (await db
    .select({ total: sql<number>`count(*)::int` })
    .from(schema.products)
    .where(whereClause)) as [{ total: number }];

  const orderBy =
    q.sort === "newest"
      ? [desc(schema.products.createdAt), desc(schema.products.id)]
      : q.sort === "oldest"
        ? [asc(schema.products.createdAt), asc(schema.products.id)]
        : q.sort === "price_asc"
          ? [asc(schema.products.priceCents), asc(schema.products.id)]
          : q.sort === "price_desc"
            ? [desc(schema.products.priceCents), desc(schema.products.id)]
            : [asc(schema.products.name), asc(schema.products.id)];

  const rows = await db
    .select({
      id: schema.products.id,
      code: schema.products.code,
      slug: schema.products.slug,
      name: schema.products.name,
      priceCents: schema.products.priceCents,
      currency: schema.products.currency,
      stockStatus: schema.products.stockStatus,
      newUntil: schema.products.newUntil,
      categoryId: schema.products.categoryId,
      categoryName: schema.categories.name,
      displayOrder: schema.products.displayOrder,
      deletedAt: schema.products.deletedAt,
      createdAt: schema.products.createdAt,
      updatedAt: schema.products.updatedAt,
    })
    .from(schema.products)
    .leftJoin(schema.categories, eq(schema.categories.id, schema.products.categoryId))
    .where(whereClause)
    .orderBy(...orderBy)
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);

  // Primary image + image count per product on this page, in one query.
  const primaryByProduct = new Map<string, string>();
  const countByProduct = new Map<string, number>();
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    const imgs = await db
      .select({
        productId: schema.productImages.productId,
        s3Key: schema.productImages.s3Key,
        displayOrder: schema.productImages.displayOrder,
      })
      .from(schema.productImages)
      .where(inArray(schema.productImages.productId, ids))
      .orderBy(asc(schema.productImages.displayOrder), asc(schema.productImages.id));
    for (const img of imgs) {
      countByProduct.set(img.productId, (countByProduct.get(img.productId) ?? 0) + 1);
      if (!primaryByProduct.has(img.productId)) {
        primaryByProduct.set(img.productId, buildImageUrl(img.s3Key));
      }
    }
  }

  const items: AdminProductSummary[] = rows.map((r) => ({
    id: r.id,
    code: r.code,
    slug: r.slug,
    name: r.name,
    priceCents: toCents(r.priceCents),
    currency: r.currency,
    stockStatus: r.stockStatus,
    isNew: isProductNew(r.newUntil),
    categoryId: r.categoryId,
    categoryName: r.categoryName ?? null,
    primaryImageUrl: primaryByProduct.get(r.id) ?? null,
    imageCount: countByProduct.get(r.id) ?? 0,
    displayOrder: r.displayOrder,
    archived: r.deletedAt !== null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));

  return c.json(
    {
      items,
      page: q.page,
      pageSize: q.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / q.pageSize)),
    },
    200,
  );
});

// ─── POST /admin/products ─────────────────────────────────────────────────────

const createRouteDef = createRoute({
  method: "post",
  path: "/",
  tags: ["admin-products"],
  summary: "Create a product (appended to the end of its category)",
  request: {
    body: { content: { "application/json": { schema: CreateRequestSchema } } },
  },
  responses: {
    201: {
      description: "The created product.",
      content: { "application/json": { schema: AdminProductDetailSchema } },
    },
    400: {
      description: "Validation error, bad slug, or unknown/deleted category.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    409: {
      description: "`/problems/product-slug-conflict` or `/problems/product-code-conflict`.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminProductsRoutes.openapi(createRouteDef, async (c) => {
  const db = getDb();
  const admin = c.get("user")!;
  const log = c.get("logger") ?? baseLogger;
  const body = c.req.valid("json");

  const slug = resolveProductSlug(body.name, body.slug);
  if (!slug) {
    throw badRequest("Could not derive a valid slug from the name.", [
      { path: "slug", message: "Provide a slug (lowercase latin, digits, hyphens)." },
    ]);
  }

  const categoryId = body.categoryId ?? null;
  if (categoryId !== null && !(await liveCategory(db, categoryId))) {
    throw badRequest("Category does not exist.", [
      { path: "categoryId", message: "Unknown or deleted category." },
    ]);
  }

  if (await slugTaken(db, slug)) throw slugConflict(slug);
  if (await codeTaken(db, body.code)) throw codeConflict(body.code);

  const resolvedNewUntil = resolveNewUntil(body.newUntil);
  if (resolvedNewUntil === "invalid") {
    throw badRequest("newUntil is not a valid timestamp.", [
      { path: "newUntil", message: "Must be an ISO-8601 timestamp or null." },
    ]);
  }
  const newUntil =
    resolvedNewUntil === undefined ? defaultNewUntil(new Date()) : resolvedNewUntil;

  const images = normalizeImages(body.images) ?? [];

  const created = await db.transaction(async (tx) => {
    const [{ maxOrder }] = (await tx
      .select({
        maxOrder: sql<number>`coalesce(max(${schema.products.displayOrder}), -1)::int`,
      })
      .from(schema.products)
      .where(
        and(
          isNull(schema.products.deletedAt),
          categoryId === null
            ? isNull(schema.products.categoryId)
            : eq(schema.products.categoryId, categoryId),
        ),
      )) as [{ maxOrder: number }];

    const [row] = await tx
      .insert(schema.products)
      .values({
        name: body.name,
        code: body.code,
        slug,
        description: body.description ?? "",
        priceCents: String(body.priceCents),
        currency: body.currency ?? "EUR",
        categoryId,
        stockStatus: body.stockStatus ?? "in_stock",
        newUntil,
        displayOrder: maxOrder + 1,
      })
      .returning();

    if (images.length > 0) {
      await tx.insert(schema.productImages).values(
        images.map((i) => ({
          productId: row!.id,
          s3Key: i.s3Key,
          altText: i.altText,
          displayOrder: i.displayOrder,
        })),
      );
    }

    await tx.insert(schema.adminAuditLog).values({
      actorUserId: admin.id,
      action: "product.create",
      entityTable: "products",
      entityId: row!.id,
      changes: {
        after: { code: row!.code, slug: row!.slug, name: row!.name, categoryId, priceCents: row!.priceCents },
      },
      userAgent: clientUserAgent(c),
    });
    return row!;
  });

  log.info({ productId: created.id, slug: created.slug, adminId: admin.id }, "product_created");
  const detail = await buildDetail(db, created.id);
  return c.json(detail!, 201);
});

// ─── POST /admin/products/reorder ─────────────────────────────────────────────

const reorderRouteDef = createRoute({
  method: "post",
  path: "/reorder",
  tags: ["admin-products"],
  summary: "Reorder the products within one category layer",
  request: {
    body: { content: { "application/json": { schema: ReorderRequestSchema } } },
  },
  responses: {
    200: {
      description: "Number of products whose order was rewritten.",
      content: {
        "application/json": {
          schema: z
            .object({ reordered: z.number().int() })
            .openapi("AdminProductReorderResult"),
        },
      },
    },
    409: {
      description:
        "`/problems/product-reorder-mismatch` — the supplied ids are not exactly that category's current live products.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminProductsRoutes.openapi(reorderRouteDef, async (c) => {
  const db = getDb();
  const admin = c.get("user")!;
  const log = c.get("logger") ?? baseLogger;
  const { categoryId, orderedIds } = c.req.valid("json");

  if (new Set(orderedIds).size !== orderedIds.length) {
    throw new ApiError({
      type: "/problems/product-reorder-mismatch",
      title: "Reorder Set Mismatch",
      status: 409,
      detail: "The ordered ids contain duplicates.",
    });
  }

  await db.transaction(async (tx) => {
    const live = await tx
      .select({ id: schema.products.id })
      .from(schema.products)
      .where(
        and(
          isNull(schema.products.deletedAt),
          categoryId === null
            ? isNull(schema.products.categoryId)
            : eq(schema.products.categoryId, categoryId),
        ),
      )
      .for("update");

    const currentIds = new Set(live.map((r) => r.id));
    const sameSize = currentIds.size === orderedIds.length;
    const sameMembers = orderedIds.every((id) => currentIds.has(id));
    if (!sameSize || !sameMembers) {
      throw new ApiError({
        type: "/problems/product-reorder-mismatch",
        title: "Reorder Set Mismatch",
        status: 409,
        detail:
          "The supplied ids are not exactly the current live products of that category. Reload and retry.",
      });
    }

    for (let i = 0; i < orderedIds.length; i++) {
      await tx
        .update(schema.products)
        .set({ displayOrder: i })
        .where(eq(schema.products.id, orderedIds[i]!));
    }

    await tx.insert(schema.adminAuditLog).values({
      actorUserId: admin.id,
      action: "product.reorder",
      entityTable: "products",
      entityId: categoryId ?? "(uncategorised)",
      changes: { after: { categoryId, orderedIds } },
      userAgent: clientUserAgent(c),
    });
  });

  log.info({ categoryId, count: orderedIds.length, adminId: admin.id }, "products_reordered");
  return c.json({ reordered: orderedIds.length }, 200);
});

// ─── GET /admin/products/:id ──────────────────────────────────────────────────

const detailRouteDef = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["admin-products"],
  summary: "Full product detail (includes archived) with its image set",
  request: { params: ParamId },
  responses: {
    200: {
      description: "The product.",
      content: { "application/json": { schema: AdminProductDetailSchema } },
    },
    404: {
      description: "`/problems/product-not-found`.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminProductsRoutes.openapi(detailRouteDef, async (c) => {
  const db = getDb();
  const { id } = c.req.valid("param");
  const detail = await buildDetail(db, id);
  if (!detail) throw productNotFound(id);
  return c.json(detail, 200);
});

// ─── PATCH /admin/products/:id ────────────────────────────────────────────────

const updateRouteDef = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["admin-products"],
  summary: "Edit, move, re-price, or re-image a product",
  request: {
    params: ParamId,
    body: { content: { "application/json": { schema: UpdateRequestSchema } } },
  },
  responses: {
    200: {
      description: "The updated product.",
      content: { "application/json": { schema: AdminProductDetailSchema } },
    },
    400: {
      description: "Validation error, bad slug, bad timestamp, or unknown category.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    404: {
      description: "`/problems/product-not-found`.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    409: {
      description:
        "`/problems/product-version-conflict`, `/problems/product-slug-conflict`, or `/problems/product-code-conflict`.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminProductsRoutes.openapi(updateRouteDef, async (c) => {
  const db = getDb();
  const admin = c.get("user")!;
  const log = c.get("logger") ?? baseLogger;
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  const expectedMs = Date.parse(body.expectedUpdatedAt);
  if (Number.isNaN(expectedMs)) {
    throw badRequest("expectedUpdatedAt is not a valid timestamp.", [
      { path: "expectedUpdatedAt", message: "Must be an ISO-8601 timestamp." },
    ]);
  }

  // Read the current row (outside the txn) for validation. The FOR UPDATE
  // re-read below is the authoritative lock.
  const [current] = await db
    .select()
    .from(schema.products)
    .where(eq(schema.products.id, id))
    .limit(1);
  if (!current) throw productNotFound(id);

  // Resolve the eventual slug/code/category for conflict + existence checks.
  const nextSlug = body.slug !== undefined ? resolveProductSlug(current.name, body.slug) : current.slug;
  if (body.slug !== undefined && !nextSlug) {
    throw badRequest("Invalid slug.", [
      { path: "slug", message: "Lowercase latin letters, digits and hyphens." },
    ]);
  }
  if (body.slug !== undefined && nextSlug !== current.slug && (await slugTaken(db, nextSlug!, id))) {
    throw slugConflict(nextSlug!);
  }
  if (body.code !== undefined && body.code !== current.code && (await codeTaken(db, body.code, id))) {
    throw codeConflict(body.code);
  }
  if (body.categoryId !== undefined && body.categoryId !== null) {
    if (!(await liveCategory(db, body.categoryId))) {
      throw badRequest("Category does not exist.", [
        { path: "categoryId", message: "Unknown or deleted category." },
      ]);
    }
  }

  const resolvedNewUntil = resolveNewUntil(body.newUntil);
  if (resolvedNewUntil === "invalid") {
    throw badRequest("newUntil is not a valid timestamp.", [
      { path: "newUntil", message: "Must be an ISO-8601 timestamp or null." },
    ]);
  }

  const images = normalizeImages(body.images); // null = leave untouched

  const outcome = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(schema.products)
      .where(eq(schema.products.id, id))
      .limit(1)
      .for("update");
    if (!locked) return { kind: "not_found" as const };
    if (locked.updatedAt.getTime() !== expectedMs) return { kind: "conflict" as const };

    const [row] = await tx
      .update(schema.products)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.slug !== undefined ? { slug: nextSlug! } : {}),
        ...(body.code !== undefined ? { code: body.code } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.priceCents !== undefined ? { priceCents: String(body.priceCents) } : {}),
        ...(body.currency !== undefined ? { currency: body.currency } : {}),
        ...(body.categoryId !== undefined ? { categoryId: body.categoryId } : {}),
        ...(body.stockStatus !== undefined ? { stockStatus: body.stockStatus } : {}),
        ...(resolvedNewUntil !== undefined ? { newUntil: resolvedNewUntil } : {}),
        // Always bump updatedAt. It keeps the optimistic-lock token monotonic
        // even on an images-only PATCH, and guarantees the .set() is never empty
        // — Drizzle throws "No values to set" on {}, and an images-only update
        // touches no scalar column (images live in their own table).
        updatedAt: new Date(),
      })
      .where(eq(schema.products.id, id))
      .returning();

    if (images !== null) {
      await tx.delete(schema.productImages).where(eq(schema.productImages.productId, id));
      if (images.length > 0) {
        await tx.insert(schema.productImages).values(
          images.map((i) => ({
            productId: id,
            s3Key: i.s3Key,
            altText: i.altText,
            displayOrder: i.displayOrder,
          })),
        );
      }
    }

    await tx.insert(schema.adminAuditLog).values({
      actorUserId: admin.id,
      action: "product.update",
      entityTable: "products",
      entityId: id,
      changes: {
        before: {
          code: locked.code,
          slug: locked.slug,
          name: locked.name,
          categoryId: locked.categoryId,
          priceCents: locked.priceCents,
          stockStatus: locked.stockStatus,
        },
        after: {
          code: row!.code,
          slug: row!.slug,
          name: row!.name,
          categoryId: row!.categoryId,
          priceCents: row!.priceCents,
          stockStatus: row!.stockStatus,
          imagesReplaced: images !== null,
        },
      },
      userAgent: clientUserAgent(c),
    });
    return { kind: "ok" as const };
  });

  if (outcome.kind === "not_found") throw productNotFound(id);
  if (outcome.kind === "conflict") throw versionConflict(id);

  log.info({ productId: id, adminId: admin.id }, "product_updated");
  const detail = await buildDetail(db, id);
  return c.json(detail!, 200);
});

// ─── DELETE /admin/products/:id ───────────────────────────────────────────────

const deleteRouteDef = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["admin-products"],
  summary: "Soft-delete (archive) a product and 301-redirect its URL",
  request: {
    params: ParamId,
    body: { content: { "application/json": { schema: DeleteRequestSchema } } },
  },
  responses: {
    200: {
      description: "Removal summary.",
      content: {
        "application/json": {
          schema: z
            .object({ archived: z.boolean(), redirectsWritten: z.number().int() })
            .openapi("AdminProductDeleteResult"),
        },
      },
    },
    404: {
      description: "`/problems/product-not-found`.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    409: {
      description: "`/problems/product-version-conflict`.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminProductsRoutes.openapi(deleteRouteDef, async (c) => {
  const db = getDb();
  const admin = c.get("user")!;
  const log = c.get("logger") ?? baseLogger;
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  const expectedMs = Date.parse(body.expectedUpdatedAt);
  if (Number.isNaN(expectedMs)) {
    throw badRequest("expectedUpdatedAt is not a valid timestamp.", [
      { path: "expectedUpdatedAt", message: "Must be an ISO-8601 timestamp." },
    ]);
  }

  // Resolve the canonical URL (and the surviving redirect target) BEFORE the
  // txn, from the live category tree — same inputs the category cascade uses.
  const catRows = await loadLiveCatRows(db);

  const result = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(schema.products)
      .where(and(eq(schema.products.id, id), isNull(schema.products.deletedAt)))
      .limit(1)
      .for("update");
    if (!locked) return { kind: "not_found" as const };
    if (locked.updatedAt.getTime() !== expectedMs) return { kind: "conflict" as const };

    // Build the redirect: product URL → its (surviving) category, or home.
    const chain = locked.categoryId ? ancestorSlugChain(catRows, locked.categoryId) : null;
    const sourcePath = productCanonicalPath(chain, locked.slug);
    const target =
      locked.categoryId && chain
        ? { targetKind: "category" as const, targetCategoryId: locked.categoryId }
        : { targetKind: "home" as const, targetCategoryId: null };

    // Idempotent on re-delete after a restore: sourcePath is UNIQUE, so refresh.
    await tx.delete(schema.redirects).where(eq(schema.redirects.sourcePath, sourcePath));
    await tx.insert(schema.redirects).values({
      sourcePath,
      targetKind: target.targetKind,
      targetCategoryId: target.targetCategoryId,
      statusCode: 301,
    });

    await tx
      .update(schema.products)
      .set({ deletedAt: new Date() })
      .where(eq(schema.products.id, id));

    await tx.insert(schema.adminAuditLog).values({
      actorUserId: admin.id,
      action: "product.delete",
      entityTable: "products",
      entityId: id,
      changes: { before: { slug: locked.slug, code: locked.code }, redirectTo: target.targetKind, sourcePath },
      userAgent: clientUserAgent(c),
    });

    return { kind: "ok" as const };
  });

  if (result.kind === "not_found") throw productNotFound(id);
  if (result.kind === "conflict") throw versionConflict(id);

  log.info({ productId: id, adminId: admin.id }, "product_deleted");
  return c.json({ archived: true, redirectsWritten: 1 }, 200);
});

// ─── POST /admin/products/:id/restore ─────────────────────────────────────────

const restoreRouteDef = createRoute({
  method: "post",
  path: "/{id}/restore",
  tags: ["admin-products"],
  summary: "Un-archive a soft-deleted product (clears its redirect)",
  request: { params: ParamId },
  responses: {
    200: {
      description: "The restored product.",
      content: { "application/json": { schema: AdminProductDetailSchema } },
    },
    404: {
      description: "`/problems/product-not-found` (no archived product with that id).",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminProductsRoutes.openapi(restoreRouteDef, async (c) => {
  const db = getDb();
  const admin = c.get("user")!;
  const log = c.get("logger") ?? baseLogger;
  const { id } = c.req.valid("param");

  const catRows = await loadLiveCatRows(db);

  const outcome = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(schema.products)
      .where(eq(schema.products.id, id))
      .limit(1)
      .for("update");
    if (!locked || locked.deletedAt === null) return { kind: "not_found" as const };

    // If its category is gone (e.g. the product was archived by a category
    // cascade-delete and only the product is being restored), re-home it to
    // uncategorised so we never resurrect a live product under a dead category.
    const categoryStillLive = locked.categoryId
      ? catRows.some((r) => r.id === locked.categoryId)
      : true;
    const restoredCategoryId = categoryStillLive ? locked.categoryId : null;

    // Remove the 301 we wrote at delete time so the URL serves the product again.
    const chain = locked.categoryId ? ancestorSlugChain(catRows, locked.categoryId) : null;
    const sourcePath = productCanonicalPath(chain, locked.slug);
    await tx.delete(schema.redirects).where(eq(schema.redirects.sourcePath, sourcePath));

    await tx
      .update(schema.products)
      .set({ deletedAt: null, categoryId: restoredCategoryId })
      .where(eq(schema.products.id, id));

    await tx.insert(schema.adminAuditLog).values({
      actorUserId: admin.id,
      action: "product.restore",
      entityTable: "products",
      entityId: id,
      changes: {
        after: { slug: locked.slug, code: locked.code, categoryId: restoredCategoryId },
        rehomed: !categoryStillLive,
      },
      userAgent: clientUserAgent(c),
    });
    return { kind: "ok" as const };
  });

  if (outcome.kind === "not_found") throw productNotFound(id);

  log.info({ productId: id, adminId: admin.id }, "product_restored");
  const detail = await buildDetail(db, id);
  return c.json(detail!, 200);
});
