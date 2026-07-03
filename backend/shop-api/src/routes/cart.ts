import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { schema, type DbClient } from "@shop/db";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "../lib/db.js";
import { ApiError, ProblemSchema, notFound } from "../lib/errors.js";
import { buildImageUrl } from "../lib/images.js";
import { validationHook } from "../lib/validation-hook.js";
import { requireAuth, type AuthVariables } from "../middleware/auth.js";

/**
 * Server-side cart for AUTHENTICATED customers only.
 *
 * Per README §5 the cart UX has two modes:
 *   - Guest:        sessionStorage on the client. NEVER hits the server.
 *   - Logged in:    persisted server-side in `carts` + `cart_items`. Survives
 *                   across devices and browser restarts. Replaces the local
 *                   guest cart on login through POST /cart/merge.
 *
 * The cart row schema only stores (cart_user_id, product_id, quantity,
 * added_at). Price and stock are NEVER snapshotted — they're refetched on
 * every read so the cart always reflects today's catalog state, matching the
 * Bulgarian-spec requirement: "Кошницата винаги показва актуалната текуща
 * цена" (the cart always shows the current live price).
 *
 * The merge strategy is silent-sum on duplicate, matching how every major
 * retailer (Amazon, eBay, Target, Etsy, Walmart) handles it: combine the
 * guest's session cart with the customer's server cart with no popups, no
 * questions. This matches the doc-comment intent on the cart_items table.
 *
 * Concurrency: cart is a single-user resource so write conflicts are extremely
 * rare in practice. We rely on Postgres `INSERT ... ON CONFLICT DO UPDATE`
 * for atomic upserts, which avoids the read-modify-write race entirely.
 *
 * All endpoints under /cart require auth (requireAuth gate). currentUser at
 * the app level has already populated c.var.user when a valid cookie is
 * present.
 */

// ─── Constants ─────────────────────────────────────────────────────────────

/**
 * Per-line quantity ceiling. The DB has no explicit stock count column
 * (catalog only models stockStatus as in_stock/out_of_stock per the original
 * spec), so we cap at a sane upper bound to deflect abuse / accidental copy-
 * paste of huge numbers. 99 is the same default as Amazon's per-line cap.
 */
const MAX_QUANTITY_PER_LINE = 99;

/**
 * Cap on items the merge endpoint will accept in one call. Guests hitting
 * this from a normal browsing session will be nowhere near it; the cap is to
 * prevent an attacker who controls the request body from triggering an
 * arbitrarily large UPSERT.
 */
const MAX_MERGE_ITEMS = 200;

// ─── DTOs ──────────────────────────────────────────────────────────────────

const StockStatusSchema = z.enum(["in_stock", "out_of_stock"]).openapi("StockStatus");

const CartItemImageSchema = z
  .object({
    url: z.string().url(),
    alt: z.string(),
  })
  .openapi("CartItemImage");

const CartLineSchema = z
  .object({
    productId: z.string().uuid(),
    slug: z.string(),
    code: z.string(),
    name: z.string(),
    /**
     * Live price. Refetched on every cart read — never snapshotted client-side.
     * Number is safe: numeric(10,0) maxes out well under MAX_SAFE_INTEGER.
     */
    priceCents: z.number().int().nonnegative(),
    currency: z.string(),
    stockStatus: StockStatusSchema,
    quantity: z.number().int().positive(),
    image: CartItemImageSchema.nullable(),
    addedAt: z.string(),
  })
  .openapi("CartLine");

const CartViewSchema = z
  .object({
    items: z.array(CartLineSchema),
    /** Sum of priceCents * quantity across in-stock items only. */
    subtotalCents: z.number().int().nonnegative(),
    /**
     * The authenticated customer's active per-account discount (0–100), or 0
     * when none is set (spec §11 „Отстъпки"). The order endpoint applies the
     * SAME percentage to this subtotal with an integer-cent floor, so the
     * storefront cart + checkout summary can show the discounted total the
     * customer will actually be charged — without a second pricing source.
     * Guests never reach this endpoint, so they never receive a discount.
     */
    discountPercent: z.number().nonnegative(),
    /** Sum of quantities across ALL lines (in or out of stock). */
    itemCount: z.number().int().nonnegative(),
    currency: z.string(),
    updatedAt: z.string(),
  })
  .openapi("CartView");

// ─── Request schemas ───────────────────────────────────────────────────────

const ProductIdParamSchema = z.object({
  productId: z.string().uuid().openapi({
    param: { name: "productId", in: "path" },
  }),
});

const QuantitySchema = z
  .number()
  .int()
  .min(1, "Quantity must be at least 1")
  .max(MAX_QUANTITY_PER_LINE, `Quantity may not exceed ${MAX_QUANTITY_PER_LINE}`);

const AddItemBodySchema = z
  .object({
    productId: z.string().uuid(),
    /**
     * Optional. Defaults to 1 — the typical "Add to cart" click. Larger
     * values come from the product detail "Quantity" stepper.
     */
    quantity: QuantitySchema.default(1),
  })
  .openapi("CartAddItemRequest");

const SetQuantityBodySchema = z
  .object({
    /**
     * Absolute quantity, NOT a delta. To remove a line, use DELETE; we
     * deliberately do NOT accept 0 here so the semantic stays clean and
     * the OpenAPI contract is unambiguous.
     */
    quantity: QuantitySchema,
  })
  .openapi("CartSetQuantityRequest");

const MergeBodySchema = z
  .object({
    items: z
      .array(
        z.object({
          productId: z.string().uuid(),
          quantity: QuantitySchema,
        }),
      )
      .max(MAX_MERGE_ITEMS, `Cannot merge more than ${MAX_MERGE_ITEMS} items at once`),
  })
  .openapi("CartMergeRequest");

// ─── Route definitions ─────────────────────────────────────────────────────

const getCartRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["cart"],
  summary: "Return the current user's cart with live price + stock",
  responses: {
    200: {
      description: "Cart contents (empty array if cart is empty).",
      content: { "application/json": { schema: CartViewSchema } },
    },
    401: {
      description: "Not authenticated.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

const addItemRoute = createRoute({
  method: "post",
  path: "/items",
  tags: ["cart"],
  summary: "Add a product to the cart (sums quantity if already present)",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: AddItemBodySchema } },
    },
  },
  responses: {
    200: {
      description: "The updated cart.",
      content: { "application/json": { schema: CartViewSchema } },
    },
    400: {
      description: "Validation error.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    401: {
      description: "Not authenticated.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    404: {
      description: "Product not found, archived, or deleted.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    409: {
      description: "Product is out of stock.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

const setQuantityRoute = createRoute({
  method: "patch",
  path: "/items/{productId}",
  tags: ["cart"],
  summary: "Set the absolute quantity of an existing cart line",
  request: {
    params: ProductIdParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: SetQuantityBodySchema } },
    },
  },
  responses: {
    200: {
      description: "The updated cart.",
      content: { "application/json": { schema: CartViewSchema } },
    },
    400: {
      description: "Validation error.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    401: {
      description: "Not authenticated.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    404: {
      description: "Cart line not found.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

const removeItemRoute = createRoute({
  method: "delete",
  path: "/items/{productId}",
  tags: ["cart"],
  summary: "Remove a product from the cart (idempotent)",
  request: { params: ProductIdParamSchema },
  responses: {
    200: {
      description:
        "The updated cart. Idempotent — succeeds even if the product was not in the cart.",
      content: { "application/json": { schema: CartViewSchema } },
    },
    401: {
      description: "Not authenticated.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

const clearCartRoute = createRoute({
  method: "delete",
  path: "/",
  tags: ["cart"],
  summary: "Empty the cart (idempotent)",
  responses: {
    200: {
      description: "An empty cart view.",
      content: { "application/json": { schema: CartViewSchema } },
    },
    401: {
      description: "Not authenticated.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

const mergeRoute = createRoute({
  method: "post",
  path: "/merge",
  tags: ["cart"],
  summary:
    "Merge a guest cart into the current user's server cart (silent-sum on duplicate)",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: MergeBodySchema } },
    },
  },
  responses: {
    200: {
      description:
        "The merged cart. Unknown / deleted product IDs are silently dropped.",
      content: { "application/json": { schema: CartViewSchema } },
    },
    400: {
      description: "Validation error.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    401: {
      description: "Not authenticated.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

// ─── Router ────────────────────────────────────────────────────────────────

export const cartRoutes = new OpenAPIHono<{ Variables: AuthVariables }>({
  defaultHook: validationHook,
});

// Every cart endpoint is gated. currentUser at the app level populates
// c.var.user when a valid cookie is present; requireAuth promotes any anon
// request to a 401.
cartRoutes.use("*", requireAuth);

cartRoutes.openapi(getCartRoute, async (c) => {
  const user = c.get("user")!;
  const db = getDb();
  const view = await readCart(db, user.id);
  return c.json(view, 200);
});

cartRoutes.openapi(addItemRoute, async (c) => {
  const user = c.get("user")!;
  const body = c.req.valid("json");
  const db = getDb();

  // 1. Verify product exists, is not soft-deleted, and is in stock. We do this
  //    BEFORE the upsert so out-of-stock additions get a clean 409 instead of
  //    silently landing in a cart line the UI then has to special-case.
  const [product] = await db
    .select({
      id: schema.products.id,
      stockStatus: schema.products.stockStatus,
    })
    .from(schema.products)
    .where(
      and(
        eq(schema.products.id, body.productId),
        isNull(schema.products.deletedAt),
      ),
    )
    .limit(1);

  if (!product) {
    throw notFound(`Product ${body.productId} not found.`);
  }
  if (product.stockStatus === "out_of_stock") {
    throw new ApiError({
      type: "/problems/out-of-stock",
      title: "Out of Stock",
      status: 409,
      detail: "This product is currently unavailable.",
    });
  }

  // 2. Make sure the cart row exists. ON CONFLICT DO NOTHING is the standard
  //    "first-touch upsert" — cheaper than SELECT-then-INSERT.
  await ensureCartExists(db, user.id);

  // 3. Atomic upsert. LEAST() clamps the post-add total to
  //    MAX_QUANTITY_PER_LINE so a malicious/accidental loop of +1s can never
  //    exceed the cap.
  //
  //    Done via raw SQL because Drizzle 0.36's onConflictDoUpdate set-clause
  //    rendering of an embedded sql template (with both column-ref AND
  //    parameter) can produce malformed SQL on some driver/version combos.
  //    Raw SQL is explicit, driver-agnostic, and inspectable.
  await upsertCartLine(db, user.id, body.productId, body.quantity);

  // 4. Bump the carts.updated_at timestamp explicitly. Drizzle's
  //    .$onUpdate(() => new Date()) only fires when we actually issue an
  //    UPDATE on `carts`, which we don't above. Touch the row so the read
  //    response reflects "this cart was just modified".
  await touchCart(db, user.id);

  const view = await readCart(db, user.id);
  return c.json(view, 200);
});

cartRoutes.openapi(setQuantityRoute, async (c) => {
  const user = c.get("user")!;
  const { productId } = c.req.valid("param");
  const body = c.req.valid("json");
  const db = getDb();

  // We allow setQuantity even for out-of-stock products — the customer might
  // be reducing their reservation. Stock validation happens at order placement
  // time (separate slice). Surface stockStatus in the response so the UI can
  // disable / warn appropriately.
  const result = await db
    .update(schema.cartItems)
    .set({ quantity: body.quantity })
    .where(
      and(
        eq(schema.cartItems.cartUserId, user.id),
        eq(schema.cartItems.productId, productId),
      ),
    );

  // Drizzle's pg/neon client returns rowCount on the result. Both drivers
  // expose it; the union type doesn't formalise it, so we feature-check.
  const rowCount =
    (result as { rowCount?: number | null } | undefined)?.rowCount ?? null;
  if (rowCount === 0) {
    throw notFound(`Cart line for product ${productId} not found.`);
  }

  await touchCart(db, user.id);
  const view = await readCart(db, user.id);
  return c.json(view, 200);
});

cartRoutes.openapi(removeItemRoute, async (c) => {
  const user = c.get("user")!;
  const { productId } = c.req.valid("param");
  const db = getDb();

  // Idempotent — return the current cart whether or not the line existed.
  // No 404 on miss matches the DELETE semantic the frontend expects (clicking
  // "remove" on a line that's already been removed elsewhere shouldn't error).
  await db
    .delete(schema.cartItems)
    .where(
      and(
        eq(schema.cartItems.cartUserId, user.id),
        eq(schema.cartItems.productId, productId),
      ),
    );

  await touchCart(db, user.id);
  const view = await readCart(db, user.id);
  return c.json(view, 200);
});

cartRoutes.openapi(clearCartRoute, async (c) => {
  const user = c.get("user")!;
  const db = getDb();

  await db
    .delete(schema.cartItems)
    .where(eq(schema.cartItems.cartUserId, user.id));

  await touchCart(db, user.id);
  const view = await readCart(db, user.id);
  return c.json(view, 200);
});

cartRoutes.openapi(mergeRoute, async (c) => {
  const user = c.get("user")!;
  const body = c.req.valid("json");
  const db = getDb();

  // Empty merge is a no-op (the user had no guest cart). Return the current
  // server cart so the frontend can hydrate from a single round-trip.
  if (body.items.length === 0) {
    const view = await readCart(db, user.id);
    return c.json(view, 200);
  }

  // Deduplicate by productId before the upsert — a malformed client could
  // submit the same productId twice, in which case we want a single row with
  // the summed quantity rather than two separate ON CONFLICT calls (the
  // second of which would clamp at MAX after the first already landed).
  const dedup = new Map<string, number>();
  for (const item of body.items) {
    const cur = dedup.get(item.productId) ?? 0;
    dedup.set(item.productId, Math.min(cur + item.quantity, MAX_QUANTITY_PER_LINE));
  }

  // Filter to products that still exist. This silently drops guest-cart
  // entries for products that have since been deleted/archived — the right
  // UX for the "I added this two weeks ago and now it's gone" case.
  const productIds = [...dedup.keys()];
  const validProductIds = await selectExistingProductIds(db, productIds);

  if (validProductIds.length === 0) {
    // Nothing to merge. Don't even bother creating the cart row.
    const view = await readCart(db, user.id);
    return c.json(view, 200);
  }

  await ensureCartExists(db, user.id);

  // Loop over the validated guest items issuing the same raw-SQL upsert as
  // POST /cart/items. We deliberately do NOT use db.transaction() here:
  //
  //   1. The driver-union DbClient (Neon HTTP vs node-pg) doesn't expose a
  //      common transaction shape with stable types — a typing rabbit-hole
  //      for what the test workload doesn't need.
  //   2. Each upsert is independently safe (idempotent on retry, atomic on
  //      its own constraint), and ensureCartExists already ran. A mid-flight
  //      failure leaves the cart with the items merged so far, which is
  //      strictly better than rolling back the partial merge — the user can
  //      retry and the silent-sum semantics handle the duplicates.
  //   3. The upsert is bounded by MAX_MERGE_ITEMS (200), so the loop is
  //      cheap.
  for (const productId of validProductIds) {
    const qty = dedup.get(productId)!;
    await upsertCartLine(db, user.id, productId, qty);
  }

  await touchCart(db, user.id);
  const view = await readCart(db, user.id);
  return c.json(view, 200);
});

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Idempotently create the carts row for this user.
 *
 * Raw SQL because Drizzle 0.36's `onConflictDoNothing({ target: column })`
 * has shown driver-specific failures — using db.execute keeps the SQL
 * explicit and driver-agnostic.
 */
async function ensureCartExists(db: DbClient, userId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO carts (user_id) VALUES (${userId}::uuid)
    ON CONFLICT (user_id) DO NOTHING
  `);
}

/**
 * Bump carts.updated_at on a write that doesn't touch the row directly
 * (item-level inserts/deletes/updates only touch cart_items). This keeps the
 * read response's `updatedAt` honest without us having to compute MAX(addedAt)
 * across cart_items every time.
 */
async function touchCart(db: DbClient, userId: string): Promise<void> {
  await db.execute(sql`
    UPDATE carts SET updated_at = now() WHERE user_id = ${userId}::uuid
  `);
}

/**
 * Atomic upsert for a single cart line. INSERT new rows; for existing rows,
 * sum the incoming quantity into the existing one and clamp at the per-line
 * cap. The LEAST() expression is the canonical Postgres pattern for a clamped
 * accumulator inside ON CONFLICT DO UPDATE.
 */
async function upsertCartLine(
  db: DbClient,
  userId: string,
  productId: string,
  quantity: number,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO cart_items (cart_user_id, product_id, quantity)
    VALUES (${userId}::uuid, ${productId}::uuid, ${quantity})
    ON CONFLICT (cart_user_id, product_id) DO UPDATE
    SET quantity = LEAST(cart_items.quantity + ${quantity}, ${MAX_QUANTITY_PER_LINE})
  `);
}

/**
 * Filter a list of product IDs to only those that still exist (not soft-
 * deleted). Used by the merge endpoint to silently drop entries for products
 * that have disappeared from the catalog since the guest cart was built.
 *
 * Uses Drizzle's `inArray` operator — it generates `IN ($1, $2, …)` with
 * each element as a separate parameter, which is the only portable way to
 * pass a JS array to Postgres through node-pg / neon-http. Trying to bind a
 * JS array to a `uuid[]` parameter in raw SQL ends up sending a composite
 * record (or a single string), which Postgres can't parse as an array
 * literal.
 */
async function selectExistingProductIds(
  db: DbClient,
  productIds: string[],
): Promise<string[]> {
  if (productIds.length === 0) return [];
  const rows = await db
    .select({ id: schema.products.id })
    .from(schema.products)
    .where(
      and(
        inArray(schema.products.id, productIds),
        isNull(schema.products.deletedAt),
      ),
    );
  return rows.map((r) => r.id);
}

/**
 * Read the current cart and hydrate every line with live price, stock status,
 * and the primary product image. Skips lines whose product has been soft-
 * deleted (cascade hasn't fired but the catalog considers them gone).
 *
 * One round-trip: a single LEFT JOIN against products + a correlated lateral
 * subquery for the lowest-displayOrder image per product.
 *
 * If the carts row does not exist yet (first read for a brand-new user), we
 * return an empty view with a synthetic updatedAt — no need to materialise
 * the carts row just to read it.
 */
async function readCart(
  db: DbClient,
  userId: string,
): Promise<{
  items: Array<{
    productId: string;
    slug: string;
    code: string;
    name: string;
    priceCents: number;
    currency: string;
    stockStatus: "in_stock" | "out_of_stock";
    quantity: number;
    image: { url: string; alt: string } | null;
    addedAt: string;
  }>;
  subtotalCents: number;
  discountPercent: number;
  itemCount: number;
  currency: string;
  updatedAt: string;
}> {
  const [cartRow] = await db
    .select({ updatedAt: schema.carts.updatedAt })
    .from(schema.carts)
    .where(eq(schema.carts.userId, userId))
    .limit(1);

  // Pull the lines. We INNER JOIN against products with the deletedAt filter
  // — this naturally drops items whose product was soft-deleted between adds
  // and reads. The LATERAL subquery picks the primary image (lowest
  // displayOrder, ties broken by id for determinism).
  const lines = await db
    .select({
      productId: schema.cartItems.productId,
      quantity: schema.cartItems.quantity,
      addedAt: schema.cartItems.addedAt,
      slug: schema.products.slug,
      code: schema.products.code,
      name: schema.products.name,
      priceCents: schema.products.priceCents,
      currency: schema.products.currency,
      stockStatus: schema.products.stockStatus,
    })
    .from(schema.cartItems)
    .innerJoin(
      schema.products,
      eq(schema.cartItems.productId, schema.products.id),
    )
    .where(
      and(
        eq(schema.cartItems.cartUserId, userId),
        isNull(schema.products.deletedAt),
      ),
    )
    .orderBy(asc(schema.cartItems.addedAt));

  // Image lookup as a single batched query rather than N+1 lateral joins.
  // For a typical cart (≤ 20 items) the IN-list is tiny and one query is the
  // simplest correct answer.
  const productIds = lines.map((l) => l.productId);
  const primaryImages = productIds.length > 0
    ? await fetchPrimaryImages(db, productIds)
    : new Map<string, { s3Key: string; altText: string }>();

  const items = lines.map((l) => {
    const img = primaryImages.get(l.productId);
    const priceCents = Number(l.priceCents);
    return {
      productId: l.productId,
      slug: l.slug,
      code: l.code,
      name: l.name,
      priceCents,
      currency: l.currency,
      stockStatus: l.stockStatus,
      quantity: l.quantity,
      image: img
        ? { url: buildImageUrl(img.s3Key), alt: img.altText }
        : null,
      addedAt: l.addedAt.toISOString(),
    };
  });

  // Subtotal excludes out-of-stock lines — they cannot be ordered, so
  // including them would mislead the customer about what they will actually
  // pay. The frontend can still display the line struck-through.
  const subtotalCents = items
    .filter((i) => i.stockStatus === "in_stock")
    .reduce((sum, i) => sum + i.priceCents * i.quantity, 0);

  // The authenticated customer's per-account percentage discount (spec §11),
  // if any. Read here so the cart + checkout summary can show the discounted
  // total; the order endpoint applies the identical percentage at placement.
  // Clamp defensively to 0–100 (the DB CHECK already guarantees the range).
  const [discountRow] = await db
    .select({ percent: schema.discounts.percent })
    .from(schema.discounts)
    .where(eq(schema.discounts.userId, userId))
    .limit(1);
  const rawDiscount = discountRow ? Number(discountRow.percent) : 0;
  const discountPercent =
    Number.isFinite(rawDiscount) && rawDiscount > 0
      ? Math.min(rawDiscount, 100)
      : 0;

  const itemCount = items.reduce((sum, i) => sum + i.quantity, 0);

  // Prefer the carts row updatedAt; fall back to "now" for brand-new users
  // who haven't materialised the row yet. Currency is read off the first
  // line if any; otherwise default. Multi-currency carts are out of scope —
  // the catalog is single-currency (EUR) per spec.
  const updatedAt = (cartRow?.updatedAt ?? new Date()).toISOString();
  const currency = items[0]?.currency ?? "EUR";

  return { items, subtotalCents, discountPercent, itemCount, currency, updatedAt };
}

/**
 * For each productId, return the primary image (lowest displayOrder, id as
 * tiebreaker). One query, one result map.
 *
 * Implemented as a plain Drizzle query + JS-side dedup rather than Postgres
 * `DISTINCT ON`. Reasons:
 *
 *   1. We need `inArray(productId, jsArray)` to bind the productIds list
 *      portably across drivers — raw SQL with `ANY($1::uuid[])` fails on
 *      node-pg because JS arrays bind as composite records.
 *   2. The dedup is trivial in JS (one Map.set guarded by has()), and the
 *      typical per-cart image count is small (≤ 20). The DB cost is
 *      effectively the same; we trade a few CPU cycles for portable SQL.
 */
async function fetchPrimaryImages(
  db: DbClient,
  productIds: string[],
): Promise<Map<string, { s3Key: string; altText: string }>> {
  const rows = await db
    .select({
      productId: schema.productImages.productId,
      s3Key: schema.productImages.s3Key,
      altText: schema.productImages.altText,
      displayOrder: schema.productImages.displayOrder,
      id: schema.productImages.id,
    })
    .from(schema.productImages)
    .where(inArray(schema.productImages.productId, productIds))
    .orderBy(
      asc(schema.productImages.productId),
      asc(schema.productImages.displayOrder),
      asc(schema.productImages.id),
    );

  // Pick the FIRST row per productId. The orderBy already sorted them so the
  // lowest displayOrder (tiebroken by id) wins.
  const map = new Map<string, { s3Key: string; altText: string }>();
  for (const r of rows) {
    if (!map.has(r.productId)) {
      map.set(r.productId, { s3Key: r.s3Key, altText: r.altText });
    }
  }
  return map;
}
