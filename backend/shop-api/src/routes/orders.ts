import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { schema, type DbClient } from "@shop/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../lib/db.js";
import {
  ApiError,
  ProblemSchema,
  badRequest,
  internal,
  notFound,
} from "../lib/errors.js";
import { buildImageUrl } from "../lib/images.js";
import { validationHook } from "../lib/validation-hook.js";
import { requireAuth, type AuthVariables } from "../middleware/auth.js";

/**
 * Order placement & retrieval for AUTHENTICATED customers.
 *
 * Flow (POST /orders):
 *
 *   1. Reject if email is not verified — schema doc-comment on users:
 *      "email_verified_at: NULL means the user can browse but cannot place
 *       orders." Until the email-verification slice lands, customers seeded
 *      directly with emailVerifiedAt set will pass; customers registered
 *      through the live API still have a NULL emailVerifiedAt and will get a
 *      403 with type=/problems/email-not-verified — which is the right UX.
 *
 *   2. Idempotency replay. The client generates a v4 UUID and sends it in
 *      the `Idempotency-Key` header (Stripe / MDN / RFC-style). If we already
 *      have an order with this (customer_id, idempotency_key), return it
 *      verbatim — the client retried after a network blip. Different clients
 *      with the same key collide on the global UNIQUE constraint and the
 *      second one gets a 409.
 *
 *   3. Transactional checkout, against node-postgres via Drizzle's
 *      `db.transaction(...)`:
 *        a. SELECT cart_items JOIN products WHERE deleted_at IS NULL FOR UPDATE
 *           — locks the products rows for the duration of the txn so a
 *           concurrent admin can't soft-delete or stock-toggle a product
 *           between the validation and the snapshot. Also blocks two parallel
 *           checkouts on the same products from racing each other (the second
 *           one waits for the first commit before re-checking stock).
 *        b. Validate cart not empty, every line still in_stock.
 *        c. Generate the human-facing orderNumber via the dedicated sequence:
 *             to_char(now() AT TIME ZONE 'Europe/Sofia', 'YYYY-MM')
 *               || '-' || lpad(nextval(seq)::text, 5, '0')
 *           Sofia time deliberately because the spec is a Bulgarian shop —
 *           the customer's expectation is that the month label matches their
 *           local calendar.
 *        d. Compute money: subtotal = Σ unit_price × quantity; discountPercent
 *           from the per-user discounts table (0 if no row); discountAmount =
 *           floor(subtotal × pct / 100) — integer cents only, no float drift.
 *        e. Insert orders + order_items + order_status_history (status =
 *           processing, the seed entry); plus order_delivery_address if
 *           cash_on_delivery; plus order_corporate_data if the user has a
 *           corporate profile.
 *        f. DELETE cart_items for this user. The whole txn either commits or
 *           rolls back atomically — there is no state where the order exists
 *           but the cart is still populated, or vice versa.
 *
 *   4. Response: the order in its full DTO shape, suitable for the order
 *      confirmation page and the email receipt.
 *
 * Money handling: all amounts are integer cents at rest (numeric(10,0) /
 * numeric(12,0)) and as plain JS Numbers in the API. Numbers up to ~9 ×10¹⁵
 * are exactly representable, far above any realistic basket total. We never
 * multiply through floats inside the txn — discount is computed via integer
 * arithmetic with a single Math.floor at the end.
 */

// ─── DTOs ──────────────────────────────────────────────────────────────────

const PaymentMethodSchema = z
  .enum(["cash_on_delivery", "pay_at_store"])
  .openapi("PaymentMethod");

const OrderStatusSchema = z
  .enum([
    "processing",
    "shipped",
    "ready_for_pickup",
    "delivered",
    "accepted",
    "returned",
    "cancelled",
  ])
  .openapi("OrderStatus");

const DeliveryAddressInputSchema = z
  .object({
    city: z.string().trim().min(1).max(120),
    postalCode: z.string().trim().min(1).max(20),
    street: z.string().trim().min(1).max(240),
    apartmentOrOffice: z.string().trim().max(120).optional(),
  })
  .openapi("DeliveryAddressInput");

const DeliveryAddressSchema = z
  .object({
    city: z.string(),
    postalCode: z.string(),
    street: z.string(),
    apartmentOrOffice: z.string().nullable(),
  })
  .openapi("DeliveryAddress");

const CorporateDataSchema = z
  .object({
    companyName: z.string(),
    eik: z.string(),
    vatNumber: z.string().nullable(),
    registeredAddress: z.string(),
    mol: z.string(),
    contactName: z.string(),
  })
  .openapi("OrderCorporateData");

const OrderItemSchema = z
  .object({
    productId: z.string().uuid().nullable(),
    productCode: z.string(),
    productName: z.string(),
    productImageUrl: z.string().url().nullable(),
    /** Snapshot of the price at the moment of placement. */
    unitPriceCents: z.number().int().nonnegative(),
    quantity: z.number().int().positive(),
    discountAmountCents: z.number().int().nonnegative(),
  })
  .openapi("OrderItem");

const OrderSchema = z
  .object({
    id: z.string().uuid(),
    orderNumber: z.string(),
    status: OrderStatusSchema,
    paymentMethod: PaymentMethodSchema,
    customerEmail: z.string(),
    customerName: z.string(),
    customerPhone: z.string(),
    subtotalCents: z.number().int().nonnegative(),
    discountPercent: z.number().nonnegative(),
    discountAmountCents: z.number().int().nonnegative(),
    totalCents: z.number().int().nonnegative(),
    currency: z.string(),
    items: z.array(OrderItemSchema),
    deliveryAddress: DeliveryAddressSchema.nullable(),
    corporateData: CorporateDataSchema.nullable(),
    notes: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("Order");

const OrdersListSchema = z
  .object({
    items: z.array(OrderSchema),
  })
  .openapi("OrdersList");

// ─── Request schemas ───────────────────────────────────────────────────────

/**
 * Idempotency-Key header. Per modern best practice (MDN, Stripe, RFC drafts)
 * the client generates a v4 UUID and sends it in this header. Server stores
 * it on the resulting order and returns the same order on retry.
 *
 * We require the header — making it optional invites clients to skip retry
 * safety entirely. Clients that genuinely don't care can still send a fresh
 * UUID per request and get the unconditional behaviour.
 *
 * Header naming note: the z.object key MUST be lowercase because Hono
 * normalises every incoming header name to lowercase before handing it to
 * the validator (so `c.req.valid("header")` returns `{ "idempotency-key":
 * "..." }`, never `"Idempotency-Key"`). zod-to-openapi's parameter walker
 * also reads the schema key as the parameter name and throws a
 * `ConflictError("Conflicting names for parameter")` if `.openapi({ param:
 * { name } })` overrides it with a different-cased value. The OpenAPI spec
 * will therefore advertise `name: "idempotency-key"` — semantically identical
 * because HTTP header names are case-insensitive (RFC 9110 §5.1).
 */
const IdempotencyKeySchema = z
  .string()
  .min(8, "Idempotency-Key must be at least 8 characters")
  .max(255, "Idempotency-Key is too long")
  .openapi({
    example: "a1b2c3d4-e5f6-4789-a012-b3c4d5e6f789",
    description:
      "Client-generated UUID. Replays return the original order verbatim.",
  });

const HeadersSchema = z.object({
  "idempotency-key": IdempotencyKeySchema,
});

const PlaceOrderBodySchema = z
  .object({
    paymentMethod: PaymentMethodSchema,
    /**
     * Required when paymentMethod === "cash_on_delivery". Forbidden (or
     * ignored) for "pay_at_store" — the customer collects in person, no
     * shipping needed. The route handler enforces this conditional shape;
     * keeping it at the top level (rather than a discriminated union) makes
     * the OpenAPI spec friendlier for codegen.
     */
    deliveryAddress: DeliveryAddressInputSchema.optional(),
    /**
     * Optional free-form note. Visible to the admin handling the order.
     * Lightly bounded to deflect garbage; tighter limits live in admin tooling.
     */
    notes: z.string().trim().max(2000).optional(),
  })
  .openapi("PlaceOrderRequest");

const OrderNumberParamSchema = z.object({
  orderNumber: z.string().min(1).max(64).openapi({
    param: { name: "orderNumber", in: "path" },
  }),
});

// ─── Route definitions ─────────────────────────────────────────────────────

const placeOrderRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["orders"],
  summary: "Place an order from the current cart",
  request: {
    headers: HeadersSchema,
    body: {
      required: true,
      content: { "application/json": { schema: PlaceOrderBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Order placed (or idempotency replay returning the prior order).",
      content: { "application/json": { schema: OrderSchema } },
    },
    400: {
      description: "Validation error.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    401: {
      description: "Not authenticated.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    403: {
      description: "Email not verified.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    409: {
      description:
        "Cart contains an out-of-stock item, OR the idempotency key was already used by a different customer.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    422: {
      description: "Cart is empty, or business-rule validation failed.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

const listOrdersRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["orders"],
  summary: "List the current user's orders, newest first",
  responses: {
    200: {
      description: "Up to 50 orders newest first.",
      content: { "application/json": { schema: OrdersListSchema } },
    },
    401: {
      description: "Not authenticated.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

const getOrderRoute = createRoute({
  method: "get",
  path: "/{orderNumber}",
  tags: ["orders"],
  summary: "Fetch one order by its public orderNumber (must belong to current user)",
  request: { params: OrderNumberParamSchema },
  responses: {
    200: {
      description: "The order detail.",
      content: { "application/json": { schema: OrderSchema } },
    },
    401: {
      description: "Not authenticated.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    404: {
      description: "Order not found, or does not belong to this user.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

// ─── Router ────────────────────────────────────────────────────────────────

export const ordersRoutes = new OpenAPIHono<{ Variables: AuthVariables }>({
  defaultHook: validationHook,
});

ordersRoutes.use("*", requireAuth);

ordersRoutes.openapi(placeOrderRoute, async (c) => {
  const user = c.get("user")!;
  const body = c.req.valid("json");
  // Hono lower-cases header names per HTTP/2 convention; the validated header
  // map preserves this. The validator above checks both the literal value
  // and the presence — c.req.valid("header") cannot return undefined here.
  const headers = c.req.valid("header");
  const idempotencyKey = headers["idempotency-key"];
  const db = getDb();

  // ─ Email-verified gate ───────────────────────────────────────────────────
  // The order schema requires customerEmail; we use the user's verified
  // email. Unverified users can browse and build a cart, but placing an
  // order locks the email/account binding to a confirmed contact.
  if (!user.emailVerifiedAt) {
    throw new ApiError({
      type: "/problems/email-not-verified",
      title: "Email Not Verified",
      status: 403,
      detail:
        "Confirm your email address before placing an order. Re-send the verification email from your account settings.",
    });
  }

  // ─ Conditional body validation ───────────────────────────────────────────
  if (body.paymentMethod === "cash_on_delivery" && !body.deliveryAddress) {
    throw badRequest(
      "deliveryAddress is required when paymentMethod is cash_on_delivery.",
      [{ path: "deliveryAddress", message: "Required for cash_on_delivery" }],
    );
  }

  // ─ Idempotency replay ────────────────────────────────────────────────────
  // Cheap pre-check OUTSIDE the transaction. If the same customer is replaying
  // a prior request, return the saved order without re-running the txn.
  const replay = await findOrderForIdempotencyKey(db, user.id, idempotencyKey);
  if (replay) {
    return c.json(replay, 201);
  }

  // ─ Snapshot the customer ─────────────────────────────────────────────────
  // Personal accounts read from customer_profiles. Corporate accounts read
  // from corporate_profiles (contactName / contactPhone are the buyer-on-
  // record). Admins shouldn't be hitting this endpoint at all (the gate
  // doesn't enforce role, but admins have no profile and would 422 here).
  const snapshot = await loadCustomerSnapshot(db, user);
  if (!snapshot) {
    throw new ApiError({
      type: "/problems/profile-required",
      title: "Profile Required",
      status: 422,
      detail: "Complete your profile before placing an order.",
    });
  }

  // ─ The atomic checkout ───────────────────────────────────────────────────
  let placed: z.infer<typeof OrderSchema>;
  try {
    placed = await db.transaction(async (tx) => {
      // 1. Lock + read cart items joined to products. The FOR UPDATE on
      //    products is what stops concurrent admin soft-deletes or stock
      //    toggles from racing the validation. Two parallel checkouts on the
      //    same product also serialise here; the second one waits.
      //
      //    Drizzle's .for("update") attaches a SELECT … FOR UPDATE clause
      //    to the locked tables. We lock on `products` (the contended
      //    resource); the cart_items rows are owned by this user alone, so
      //    locking them too would just add overhead.
      const lines = await tx
        .select({
          productId: schema.products.id,
          quantity: schema.cartItems.quantity,
          slug: schema.products.slug,
          code: schema.products.code,
          name: schema.products.name,
          priceCents: schema.products.priceCents,
          currency: schema.products.currency,
          stockStatus: schema.products.stockStatus,
          deletedAt: schema.products.deletedAt,
        })
        .from(schema.cartItems)
        .innerJoin(
          schema.products,
          eq(schema.cartItems.productId, schema.products.id),
        )
        .where(eq(schema.cartItems.cartUserId, user.id))
        // `.for('update', { of: [products] })` instructs Postgres to lock the
        // products rows specifically (not also cart_items). The cart_items
        // rows are owned by this user alone, so locking them adds nothing.
        // Drizzle's typing for `of` expects an array of tables.
        .for("update", { of: [schema.products] });

      // 2. Filter out soft-deleted products silently — the cart UI already
      //    hides them. Then validate the rest.
      const live = lines.filter((l) => l.deletedAt === null);
      if (live.length === 0) {
        throw new ApiError({
          type: "/problems/cart-empty",
          title: "Cart Empty",
          status: 422,
          detail: "Add at least one product to the cart before checking out.",
        });
      }

      const oos = live.filter((l) => l.stockStatus === "out_of_stock");
      if (oos.length > 0) {
        throw new ApiError({
          type: "/problems/out-of-stock",
          title: "Out of Stock",
          status: 409,
          detail:
            "One or more products in your cart are out of stock. Remove them and try again.",
          // Surface the offending product codes so the frontend can highlight.
          errors: oos.map((l) => ({
            path: l.code,
            message: `${l.name} is out of stock.`,
          })),
        });
      }

      // 3. Money — integer cents only, never floats.
      const subtotalCents = live.reduce(
        (sum, l) => sum + Number(l.priceCents) * l.quantity,
        0,
      );

      // Discount lookup inlined here. We can't pull it into a shared helper
      // typed `(db: DbClient, …)` because `tx` (a `PgTransaction<HKT, …>`)
      // is not structurally a member of the `DbClient` union — its query-
      // result HKT differs from both node-pg and neon-http. The transaction
      // exposes the same `.select / .from / .where` shape at runtime, so
      // the inline query stays trivial. Same applies to the image lookup
      // below.
      const [discRow] = await tx
        .select({ percent: schema.discounts.percent })
        .from(schema.discounts)
        .where(eq(schema.discounts.userId, user.id))
        .limit(1);
      const rawDiscount = discRow ? Number(discRow.percent) : 0;
      const discountPercent =
        Number.isFinite(rawDiscount) && rawDiscount > 0
          ? Math.min(rawDiscount, 100)
          : 0;
      const discountAmountCents = Math.floor(
        (subtotalCents * discountPercent) / 100,
      );
      const totalCents = subtotalCents - discountAmountCents;

      // Currency: every line shares one currency in the catalog (single-EUR
      // by spec). Defensively read the first line's currency.
      const currency = live[0]!.currency;

      // 4. Generate the public order number atomically with the insert.
      //    Sequence advance is its own crash-safe operation in Postgres.
      const numRows = await tx.execute(sql`
        SELECT
          to_char(now() AT TIME ZONE 'Europe/Sofia', 'YYYY-MM')
            || '-' || lpad(nextval('orders_order_number_seq')::text, 5, '0')
            AS order_number
      `);
      const numRow = pickFirstRow<{ order_number: string }>(numRows);
      if (!numRow) throw internal("Failed to generate orderNumber");
      const orderNumber = numRow.order_number;

      // 5. Insert the order header.
      const guestTrackToken =
        // crypto.randomUUID is guaranteed in Node ≥19 (we're on ≥20).
        // We populate it for every order — even logged-in ones — so future
        // shareable-tracking-link UX doesn't require a backfill.
        crypto.randomUUID();

      const [order] = await tx
        .insert(schema.orders)
        .values({
          orderNumber,
          customerId: user.id,
          idempotencyKey,
          guestTrackToken,
          status: "processing",
          paymentMethod: body.paymentMethod,
          customerEmail: user.email,
          customerName: snapshot.name,
          customerPhone: snapshot.phone,
          subtotalCents: String(subtotalCents),
          discountPercent: discountPercent.toFixed(2),
          discountAmountCents: String(discountAmountCents),
          totalCents: String(totalCents),
          notes: body.notes ?? null,
        })
        .returning();
      if (!order) throw internal("Failed to insert order");

      // 6. Insert line items — one snapshot row per cart line. Per-line
      //    discount currently zero; the spec only carries account-level
      //    discount, but the column exists on order_items for forward
      //    compatibility (e.g. coupon-on-line in a future slice).
      //
      //    Primary-image lookup is inlined for the same `tx`-vs-DbClient
      //    type reason as the discount lookup above: one batched query
      //    against product_images, JS-side dedup picks the lowest
      //    displayOrder per product (id as tiebreaker for determinism).
      const productIds = live.map((l) => l.productId);
      const primaryImages = new Map<
        string,
        { s3Key: string; altText: string }
      >();
      if (productIds.length > 0) {
        const imgRows = await tx
          .select({
            productId: schema.productImages.productId,
            s3Key: schema.productImages.s3Key,
            altText: schema.productImages.altText,
          })
          .from(schema.productImages)
          .where(inArray(schema.productImages.productId, productIds))
          .orderBy(
            schema.productImages.productId,
            schema.productImages.displayOrder,
            schema.productImages.id,
          );
        for (const r of imgRows) {
          if (!primaryImages.has(r.productId)) {
            primaryImages.set(r.productId, {
              s3Key: r.s3Key,
              altText: r.altText,
            });
          }
        }
      }

      const itemValues = live.map((l) => {
        const img = primaryImages.get(l.productId);
        return {
          orderId: order.id,
          productId: l.productId,
          productCode: l.code,
          productName: l.name,
          productImageS3Key: img?.s3Key ?? null,
          unitPriceCents: String(l.priceCents),
          quantity: l.quantity,
          discountAmountCents: "0",
        };
      });
      const insertedItems = await tx
        .insert(schema.orderItems)
        .values(itemValues)
        .returning();

      // 7. Status-history seed entry.
      await tx.insert(schema.orderStatusHistory).values({
        orderId: order.id,
        status: "processing",
        changedByUserId: user.id,
        note: null,
      });

      // 8. Delivery address snapshot — only for cash_on_delivery. Pickup
      //    orders skip this entirely per the schema doc-comment.
      if (body.paymentMethod === "cash_on_delivery" && body.deliveryAddress) {
        await tx.insert(schema.orderDeliveryAddress).values({
          orderId: order.id,
          city: body.deliveryAddress.city,
          postalCode: body.deliveryAddress.postalCode,
          street: body.deliveryAddress.street,
          apartmentOrOffice: body.deliveryAddress.apartmentOrOffice ?? null,
        });
      }

      // 9. Corporate data snapshot — only for corporate accounts. We snapshot
      //    from the live profile here; future per-order overrides (different
      //    delivery contact, etc.) can land as additional optional fields on
      //    the request body.
      if (snapshot.kind === "corporate") {
        await tx.insert(schema.orderCorporateData).values({
          orderId: order.id,
          companyName: snapshot.corp.companyName,
          eik: snapshot.corp.eik,
          vatNumber: snapshot.corp.vatNumber,
          registeredAddress: snapshot.corp.registeredAddress,
          mol: snapshot.corp.mol,
          contactName: snapshot.corp.contactName,
        });
      }

      // 10. Empty the cart. The carts row stays — it's keyed on user_id and
      //     gets reused for the next checkout.
      await tx.delete(schema.cartItems).where(
        eq(schema.cartItems.cartUserId, user.id),
      );

      return shapeOrderResponse({
        order,
        items: insertedItems,
        deliveryAddress:
          body.paymentMethod === "cash_on_delivery" && body.deliveryAddress
            ? {
                city: body.deliveryAddress.city,
                postalCode: body.deliveryAddress.postalCode,
                street: body.deliveryAddress.street,
                apartmentOrOffice: body.deliveryAddress.apartmentOrOffice ?? null,
              }
            : null,
        corporateData:
          snapshot.kind === "corporate"
            ? {
                companyName: snapshot.corp.companyName,
                eik: snapshot.corp.eik,
                vatNumber: snapshot.corp.vatNumber,
                registeredAddress: snapshot.corp.registeredAddress,
                mol: snapshot.corp.mol,
                contactName: snapshot.corp.contactName,
              }
            : null,
        currency,
      });
    });
  } catch (e) {
    // The unique-violation on idempotency_key is the canonical cross-customer
    // collision case (extremely unlikely with v4 UUIDs but possible). Map it
    // to a 409 instead of a 500.
    const code = (e as { code?: string }).code;
    if (code === "23505") {
      // Re-fetch in case a sibling request just won the race for this key.
      const won = await findOrderForIdempotencyKey(db, user.id, idempotencyKey);
      if (won) return c.json(won, 201);
      throw new ApiError({
        type: "/problems/idempotency-conflict",
        title: "Idempotency Conflict",
        status: 409,
        detail:
          "This idempotency key was already used for a different request. Generate a new key and retry.",
      });
    }
    throw e;
  }

  return c.json(placed, 201);
});

ordersRoutes.openapi(listOrdersRoute, async (c) => {
  const user = c.get("user")!;
  const db = getDb();
  const items = await listOrdersForUser(db, user.id);
  return c.json({ items }, 200);
});

ordersRoutes.openapi(getOrderRoute, async (c) => {
  const user = c.get("user")!;
  const { orderNumber } = c.req.valid("param");
  const db = getDb();

  const order = await findOrderByNumberForUser(db, user.id, orderNumber);
  if (!order) {
    throw notFound(`Order ${orderNumber} not found.`);
  }
  return c.json(order, 200);
});

// ─── Helpers ───────────────────────────────────────────────────────────────

type CustomerSnapshot =
  | {
      kind: "personal";
      name: string;
      phone: string;
    }
  | {
      kind: "corporate";
      name: string;
      phone: string;
      corp: {
        companyName: string;
        eik: string;
        vatNumber: string | null;
        registeredAddress: string;
        mol: string;
        contactName: string;
      };
    };

/**
 * Read the customer's name + phone from whichever profile table applies.
 * Returns null only if the user has no profile row (e.g. an admin trying to
 * place an order). The caller maps null → 422.
 */
async function loadCustomerSnapshot(
  db: DbClient,
  user: { id: string; accountType: "personal" | "corporate" | null },
): Promise<CustomerSnapshot | null> {
  if (user.accountType === "personal") {
    const [row] = await db
      .select({
        fullName: schema.customerProfiles.fullName,
        phone: schema.customerProfiles.phone,
      })
      .from(schema.customerProfiles)
      .where(eq(schema.customerProfiles.userId, user.id))
      .limit(1);
    if (!row) return null;
    return { kind: "personal", name: row.fullName, phone: row.phone };
  }
  if (user.accountType === "corporate") {
    const [row] = await db
      .select({
        companyName: schema.corporateProfiles.companyName,
        eik: schema.corporateProfiles.eik,
        vatNumber: schema.corporateProfiles.vatNumber,
        registeredAddress: schema.corporateProfiles.registeredAddress,
        mol: schema.corporateProfiles.mol,
        contactName: schema.corporateProfiles.contactName,
        contactPhone: schema.corporateProfiles.contactPhone,
      })
      .from(schema.corporateProfiles)
      .where(eq(schema.corporateProfiles.userId, user.id))
      .limit(1);
    if (!row) return null;
    return {
      kind: "corporate",
      name: row.contactName,
      phone: row.contactPhone,
      corp: {
        companyName: row.companyName,
        eik: row.eik,
        vatNumber: row.vatNumber ?? null,
        registeredAddress: row.registeredAddress,
        mol: row.mol,
        contactName: row.contactName,
      },
    };
  }
  return null;
}

/**
 * Replay lookup for the idempotency key. Scoped to the customer so an
 * attacker who guesses someone else's key doesn't leak their order.
 *
 * The schema's UNIQUE on idempotency_key is global — if customer A's key is
 * reused by customer B, the INSERT will fail with 23505 and the route maps
 * that to a clean 409 (handled inline in placeOrderRoute, not here).
 */
async function findOrderForIdempotencyKey(
  db: DbClient,
  customerId: string,
  idempotencyKey: string,
): Promise<z.infer<typeof OrderSchema> | null> {
  const [order] = await db
    .select()
    .from(schema.orders)
    .where(
      and(
        eq(schema.orders.customerId, customerId),
        eq(schema.orders.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  if (!order) return null;
  return loadFullOrder(db, order);
}

/**
 * Hydrate a single order row into the API DTO, including line items, image
 * URLs, address & corporate side-tables.
 */
async function loadFullOrder(
  db: DbClient,
  order: typeof schema.orders.$inferSelect,
): Promise<z.infer<typeof OrderSchema>> {
  const [items, [delivery], [corp]] = await Promise.all([
    db
      .select()
      .from(schema.orderItems)
      .where(eq(schema.orderItems.orderId, order.id)),
    db
      .select()
      .from(schema.orderDeliveryAddress)
      .where(eq(schema.orderDeliveryAddress.orderId, order.id))
      .limit(1),
    db
      .select()
      .from(schema.orderCorporateData)
      .where(eq(schema.orderCorporateData.orderId, order.id))
      .limit(1),
  ]);

  // Currency comes off the catalog at insert time but we don't snapshot it
  // on the order row (single-EUR by spec). Default EUR; if a future slice
  // needs multi-currency it'll add a column.
  return shapeOrderResponse({
    order,
    items,
    deliveryAddress: delivery
      ? {
          city: delivery.city,
          postalCode: delivery.postalCode,
          street: delivery.street,
          apartmentOrOffice: delivery.apartmentOrOffice ?? null,
        }
      : null,
    corporateData: corp
      ? {
          companyName: corp.companyName,
          eik: corp.eik,
          vatNumber: corp.vatNumber ?? null,
          registeredAddress: corp.registeredAddress,
          mol: corp.mol,
          contactName: corp.contactName,
        }
      : null,
    currency: "EUR",
  });
}

async function listOrdersForUser(
  db: DbClient,
  userId: string,
): Promise<z.infer<typeof OrderSchema>[]> {
  const rows = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.customerId, userId))
    .orderBy(desc(schema.orders.createdAt))
    .limit(50);
  if (rows.length === 0) return [];
  // Hydrate one-by-one. 50-cap × ~5 small queries each is acceptable for a
  // customer's order history; the read pattern is N+1 on a known-small N.
  // If this becomes hot, batch the line-items fetch in one IN-list query.
  return Promise.all(rows.map((o) => loadFullOrder(db, o)));
}

async function findOrderByNumberForUser(
  db: DbClient,
  userId: string,
  orderNumber: string,
): Promise<z.infer<typeof OrderSchema> | null> {
  const [order] = await db
    .select()
    .from(schema.orders)
    .where(
      and(
        eq(schema.orders.customerId, userId),
        eq(schema.orders.orderNumber, orderNumber),
      ),
    )
    .limit(1);
  if (!order) return null;
  return loadFullOrder(db, order);
}

/**
 * Final shape for the JSON response. Centralised so list / detail / place
 * all return the same structure.
 *
 * Image URLs are derived from each order_items row's stored
 * `productImageS3Key` snapshot — the response never has to refetch from
 * `product_images`, so the order detail is correct even if the product or
 * the image was later deleted from the catalog.
 */
function shapeOrderResponse(input: {
  order: typeof schema.orders.$inferSelect;
  items: (typeof schema.orderItems.$inferSelect)[];
  deliveryAddress: {
    city: string;
    postalCode: string;
    street: string;
    apartmentOrOffice: string | null;
  } | null;
  corporateData: {
    companyName: string;
    eik: string;
    vatNumber: string | null;
    registeredAddress: string;
    mol: string;
    contactName: string;
  } | null;
  currency: string;
}): z.infer<typeof OrderSchema> {
  const { order, items, deliveryAddress, corporateData, currency } = input;
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentMethod: order.paymentMethod,
    customerEmail: order.customerEmail,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    subtotalCents: Number(order.subtotalCents),
    discountPercent: Number(order.discountPercent),
    discountAmountCents: Number(order.discountAmountCents),
    totalCents: Number(order.totalCents),
    currency,
    items: items.map((it) => ({
      productId: it.productId ?? null,
      productCode: it.productCode,
      productName: it.productName,
      productImageUrl: it.productImageS3Key
        ? buildImageUrl(it.productImageS3Key)
        : null,
      unitPriceCents: Number(it.unitPriceCents),
      quantity: it.quantity,
      discountAmountCents: Number(it.discountAmountCents),
    })),
    deliveryAddress,
    corporateData,
    notes: order.notes ?? null,
    createdAt: order.createdAt.toISOString(),
  };
}

/**
 * Driver-portable first-row pick for raw `db.execute(sql\`…\`)` results.
 * neon-http returns the rows array directly; node-pg returns { rows: [...] }.
 * We check both and return the first row, or null.
 */
function pickFirstRow<T>(result: unknown): T | null {
  if (Array.isArray(result)) {
    return (result[0] as T | undefined) ?? null;
  }
  const r = result as { rows?: unknown[] } | null | undefined;
  if (r && Array.isArray(r.rows)) {
    return (r.rows[0] as T | undefined) ?? null;
  }
  return null;
}
