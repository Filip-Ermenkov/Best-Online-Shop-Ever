import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { schema, type DbClient } from "@shop/db";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "../lib/db.js";
import {
  ApiError,
  ProblemSchema,
  badRequest,
  internal,
  notFound,
} from "../lib/errors.js";
import { buildImageUrl } from "../lib/images.js";
import { logger as baseLogger } from "../lib/logger.js";
import { validationHook } from "../lib/validation-hook.js";
import { parseEnv } from "../lib/env.js";
import { normalizeBulgarianPhone } from "../lib/phone.js";
import {
  issueGuestTrackToken,
  isWellFormedTrackToken,
} from "../lib/guest-track.js";
import { clientIpFromXff, createRateLimiter } from "../lib/rate-limit.js";
import { cancelOrderByCustomer } from "../lib/order-cancellation.js";
import {
  sendOrderConfirmationEmail,
  sendOrderStatusUpdateEmail,
} from "../lib/order-emails.js";
import {
  createOrFetchWithdrawalRecord,
  deriveSupportEmail,
  evaluateWithdrawalEligibilityForOrder,
  markWithdrawalAcknowledged,
  sendWithdrawalAcknowledgementEmail,
  sendWithdrawalAdminNotificationEmail,
  WITHDRAWAL_WINDOW_DAYS,
  type WithdrawalRecord,
} from "../lib/withdrawal.js";

/**
 * PUBLIC guest surface — the spec's "Гост" role (`docs/README.md` §"Роли",
 * §7), which is mandatory because "Регистрацията е по желание": a visitor must
 * be able to buy, track, cancel, and exercise the 14-day withdrawal WITHOUT an
 * account. None of these routes mount `requireAuth`; the order's tracking token
 * is the only credential the guest paths recognise.
 *
 * Two routers exported from one file because they share the order serializer,
 * the token plumbing, and the withdrawal/cancel logic:
 *
 *   guestRoutes  (mounted at /guest)
 *     POST /guest/orders                         place an order with no account
 *
 *   trackRoutes  (mounted at /track)
 *     GET  /track/:token                         view the order (capability URL)
 *     POST /track/:token/cancel                  cancel while still 'processing'
 *     GET  /track/:token/withdrawal/eligibility  14-day-right eligibility
 *     POST /track/:token/withdrawal              submit the 14-day withdrawal
 *     POST /track/find                           re-send the lost tracking link
 *
 * The token is a 256-bit capability URL — see `lib/guest-track.ts` for the full
 * security rationale (why it's durable, why it's plaintext-at-rest, the leak
 * mitigations). Unknown / malformed tokens always return a uniform 404, the
 * same enumeration-resistant stance the rest of the orders API takes.
 */

// ─── Anti-abuse limiters (in-memory, per container — see lib/rate-limit.ts) ──

/**
 * Anonymous order placement is a spam/COD-fraud vector, so we cap it per IP.
 * Generous (a real shopper places one order); the cap only bites bots. The
 * Idempotency-Key already de-dupes honest retries, so this never blocks them.
 */
const placeLimiter = createRateLimiter({ limit: 30, windowMs: 60 * 60 * 1000 });

/**
 * find-my-order resend: spec §7 mandates "максимум 3 заявки на час от един IP
 * адрес". This is the exact knob.
 */
const findLimiter = createRateLimiter({ limit: 3, windowMs: 60 * 60 * 1000 });

/**
 * Test-only: clear the in-memory limiter windows. Called from tests/setup
 * (per-test.ts) `beforeEach`, mirroring the CSP-report and data-export reset
 * hooks, so a limit tripped in one test never bleeds into the next.
 */
export function _resetGuestRateLimitsForTests(): void {
  placeLimiter.reset();
  findLimiter.reset();
}

// ─── Shared DTO fragments ────────────────────────────────────────────────────

const ORDER_STATUS_VALUES = [
  "processing",
  "shipped",
  "ready_for_pickup",
  "delivered",
  "accepted",
  "returned",
  "cancelled",
] as const;

const PAYMENT_METHOD_VALUES = ["cash_on_delivery", "pay_at_store"] as const;

const TrackOrderItemSchema = z.object({
  productName: z.string(),
  productCode: z.string(),
  productImageUrl: z.string().url().nullable(),
  unitPriceCents: z.number().int().nonnegative(),
  quantity: z.number().int().positive(),
});

const TrackDeliveryAddressSchema = z.object({
  city: z.string(),
  postalCode: z.string(),
  street: z.string(),
  apartmentOrOffice: z.string().nullable(),
});

// ─── Guest order placement ───────────────────────────────────────────────────

const GuestContactSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  name: z.string().trim().min(1).max(200),
  // Normalised to BG E.164 in the handler; loosely bounded here.
  phone: z.string().trim().min(1).max(40),
});

const GuestCartItemSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().min(1).max(99),
});

const GuestDeliveryAddressInputSchema = z.object({
  city: z.string().trim().min(1).max(120),
  postalCode: z.string().trim().min(1).max(20),
  street: z.string().trim().min(1).max(240),
  apartmentOrOffice: z.string().trim().max(120).optional(),
});

const GuestPlaceOrderBodySchema = z
  .object({
    contact: GuestContactSchema,
    paymentMethod: z.enum(PAYMENT_METHOD_VALUES),
    deliveryAddress: GuestDeliveryAddressInputSchema.optional(),
    /**
     * The guest cart travels in the body — a guest cart lives only in the
     * browser's sessionStorage (spec: "кошницата не се запазва"), so there is
     * no server cart to read. We re-validate every line against the live
     * catalog inside the checkout transaction; the client prices are never
     * trusted.
     */
    items: z.array(GuestCartItemSchema).min(1).max(100),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict()
  .openapi("GuestPlaceOrderRequest");

const GuestOrderSchema = z
  .object({
    orderNumber: z.string(),
    status: z.enum(ORDER_STATUS_VALUES),
    paymentMethod: z.enum(PAYMENT_METHOD_VALUES),
    createdAt: z.string(),
    customerName: z.string(),
    customerEmail: z.string(),
    customerPhone: z.string(),
    items: z.array(TrackOrderItemSchema),
    subtotalCents: z.number().int().nonnegative(),
    discountAmountCents: z.number().int().nonnegative(),
    totalCents: z.number().int().nonnegative(),
    currency: z.string(),
    deliveryAddress: TrackDeliveryAddressSchema.nullable(),
    /** Raw capability token — the guest's only handle on this order. */
    trackToken: z.string(),
    /** Convenience: the path to open, `/track/<token>`. */
    trackPath: z.string(),
  })
  .openapi("GuestOrder");

const HeadersSchema = z.object({
  "idempotency-key": z
    .string()
    .min(8, "Idempotency-Key must be at least 8 characters")
    .max(255, "Idempotency-Key is too long")
    .openapi({
      param: { name: "idempotency-key", in: "header" },
      example: "a1b2c3d4-e5f6-4789-a012-b3c4d5e6f789",
    }),
});

const placeGuestOrderRoute = createRoute({
  method: "post",
  path: "/orders",
  tags: ["guest"],
  summary: "Place an order as a guest (no account)",
  request: {
    headers: HeadersSchema,
    body: {
      required: true,
      content: { "application/json": { schema: GuestPlaceOrderBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Order placed (or idempotency replay returning the prior order).",
      content: { "application/json": { schema: GuestOrderSchema } },
    },
    400: {
      description: "Validation error (bad phone, missing delivery address, …).",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    409: {
      description:
        "One or more items are unavailable, OR the idempotency key was already used by a different request.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    422: {
      description: "No purchasable items in the request.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    429: {
      description: "Too many guest orders from this IP. Try again later.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

// ─── Track surface DTOs ──────────────────────────────────────────────────────

const TokenParamSchema = z.object({
  token: z.string().min(1).max(64).openapi({
    param: { name: "token", in: "path" },
  }),
});

const TrackedOrderSchema = z
  .object({
    orderNumber: z.string(),
    status: z.enum(ORDER_STATUS_VALUES),
    paymentMethod: z.enum(PAYMENT_METHOD_VALUES),
    createdAt: z.string(),
    acceptedAt: z.string().nullable(),
    customerName: z.string(),
    customerEmail: z.string(),
    customerPhone: z.string(),
    items: z.array(TrackOrderItemSchema),
    subtotalCents: z.number().int().nonnegative(),
    discountAmountCents: z.number().int().nonnegative(),
    totalCents: z.number().int().nonnegative(),
    currency: z.string(),
    deliveryAddress: TrackDeliveryAddressSchema.nullable(),
    courierCompany: z.string().nullable(),
    trackingNumber: z.string().nullable(),
    pickupDeadline: z.string().nullable(),
    statusHistory: z.array(
      z.object({ status: z.enum(ORDER_STATUS_VALUES), changedAt: z.string() }),
    ),
    /**
     * Shown on the page only when status is `shipped` / `ready_for_pickup`
     * (spec §7 "данни за контакт с магазина"). The email is always derivable;
     * the phone is optional (SHOP_CONTACT_PHONE).
     */
    shopContact: z.object({
      email: z.string(),
      phone: z.string().nullable(),
    }),
    /** Server-authoritative mirror of the cancel rule (status === processing). */
    canCancel: z.boolean(),
  })
  .openapi("TrackedOrder");

const TrackWithdrawalEligibilitySchema = z
  .discriminatedUnion("eligible", [
    z.object({
      eligible: z.literal(true),
      acceptedAt: z.string(),
      deadlineAt: z.string(),
      alreadySubmittedAt: z.string().nullable(),
      windowDays: z.number().int().positive(),
    }),
    z.object({
      eligible: z.literal(false),
      reason: z.enum(["not_accepted", "window_expired"]),
      windowDays: z.number().int().positive(),
    }),
  ])
  .openapi("TrackWithdrawalEligibility");

const TrackWithdrawalRecordSchema = z
  .object({
    id: z.string().uuid(),
    orderNumber: z.string(),
    reason: z.string().nullable(),
    submittedAt: z.string(),
    acknowledgedAt: z.string().nullable(),
  })
  .openapi("TrackWithdrawalRecord");

const WithdrawalRequestBodySchema = z
  .object({
    reason: z.string().trim().max(2000).optional(),
  })
  .openapi("TrackWithdrawalRequest");

const FindOrderBodySchema = z
  .object({
    orderNumber: z.string().trim().min(1).max(64),
    email: z.string().trim().toLowerCase().email().max(254),
  })
  .strict()
  .openapi("FindOrderRequest");

const OkSchema = z.object({ ok: z.literal(true) }).openapi("FindOrderResponse");

const getTrackRoute = createRoute({
  method: "get",
  path: "/{token}",
  tags: ["track"],
  summary: "View a guest order by its tracking token",
  request: { params: TokenParamSchema },
  responses: {
    200: {
      description: "The tracked order.",
      content: { "application/json": { schema: TrackedOrderSchema } },
    },
    404: {
      description: "No order for this token (also returned for malformed tokens).",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

const cancelTrackRoute = createRoute({
  method: "post",
  path: "/{token}/cancel",
  tags: ["track"],
  summary: "Cancel a guest order (only while 'processing')",
  request: { params: TokenParamSchema },
  responses: {
    200: {
      description: "Order cancelled; the refreshed tracked order is returned.",
      content: { "application/json": { schema: TrackedOrderSchema } },
    },
    404: {
      description: "No order for this token.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    422: {
      description: "Order is no longer in 'processing' and cannot be cancelled.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

const getTrackWithdrawalEligibilityRoute = createRoute({
  method: "get",
  path: "/{token}/withdrawal/eligibility",
  tags: ["track"],
  summary: "Check 14-day withdrawal eligibility for a guest order",
  request: { params: TokenParamSchema },
  responses: {
    200: {
      description: "Eligibility shape.",
      content: {
        "application/json": { schema: TrackWithdrawalEligibilitySchema },
      },
    },
    404: {
      description: "No order for this token.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

const postTrackWithdrawalRoute = createRoute({
  method: "post",
  path: "/{token}/withdrawal",
  tags: ["track"],
  summary: "Submit a 14-day right-of-withdrawal for a guest order",
  request: {
    params: TokenParamSchema,
    body: {
      required: false,
      content: { "application/json": { schema: WithdrawalRequestBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Withdrawal recorded; acknowledgement issued.",
      content: { "application/json": { schema: TrackWithdrawalRecordSchema } },
    },
    200: {
      description: "Idempotent replay — a withdrawal already existed.",
      content: { "application/json": { schema: TrackWithdrawalRecordSchema } },
    },
    404: {
      description: "No order for this token.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    422: {
      description: "Order not in 'accepted' status, or the window has expired.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

const findOrderRoute = createRoute({
  method: "post",
  path: "/find",
  tags: ["track"],
  summary: "Re-send a lost tracking link to the order's email (guests only)",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: FindOrderBodySchema } },
    },
  },
  responses: {
    200: {
      description:
        "Always returns { ok: true } whether or not a match was found — the response never reveals whether the order/email exist (enumeration-resistant).",
      content: { "application/json": { schema: OkSchema } },
    },
    429: {
      description: "Rate limit exceeded (3 / hour / IP).",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

// ─── Routers ─────────────────────────────────────────────────────────────────

export const guestRoutes = new OpenAPIHono({ defaultHook: validationHook });
export const trackRoutes = new OpenAPIHono({ defaultHook: validationHook });

guestRoutes.openapi(placeGuestOrderRoute, async (c) => {
  const body = c.req.valid("json");
  const headers = c.req.valid("header");
  const idempotencyKey = headers["idempotency-key"];
  const db = getDb();
  const ip = clientIpFromXff(c.req.header("x-forwarded-for"));

  // ─ Anti-abuse rate limit ─────────────────────────────────────────────────
  if (!placeLimiter.hit(ip).allowed) {
    throw new ApiError({
      type: "/problems/guest-order-rate-limited",
      title: "Too Many Requests",
      status: 429,
      detail: "Too many orders from this network. Please try again later.",
    });
  }

  // ─ Conditional body validation (mirror of the authenticated path) ─────────
  if (body.paymentMethod === "cash_on_delivery" && !body.deliveryAddress) {
    throw badRequest(
      "deliveryAddress is required when paymentMethod is cash_on_delivery.",
      [{ path: "deliveryAddress", message: "Required for cash_on_delivery" }],
    );
  }

  // ─ Normalise the contact phone ───────────────────────────────────────────
  const phone = normalizeBulgarianPhone(body.contact.phone);
  if (!phone) {
    throw badRequest("Invalid Bulgarian phone number.", [
      { path: "contact.phone", message: "Not a valid Bulgarian phone number" },
    ]);
  }

  // ─ Idempotency replay (scoped to guest orders) ───────────────────────────
  const replay = await findGuestOrderByIdempotencyKey(db, idempotencyKey);
  if (replay) return c.json(replay, 201);

  // ─ Collapse duplicate lines, then place ──────────────────────────────────
  const wanted = new Map<string, number>();
  for (const it of body.items) {
    wanted.set(it.productId, (wanted.get(it.productId) ?? 0) + it.quantity);
  }
  const wantedIds = [...wanted.keys()];

  let placed: z.infer<typeof GuestOrderSchema>;
  try {
    placed = await db.transaction(async (tx) => {
      // 1. Lock + read the requested products. FOR UPDATE serialises against a
      //    concurrent admin soft-delete / stock toggle and against parallel
      //    checkouts on the same product, exactly like the authenticated path.
      const products = await tx
        .select({
          id: schema.products.id,
          code: schema.products.code,
          name: schema.products.name,
          priceCents: schema.products.priceCents,
          currency: schema.products.currency,
          stockStatus: schema.products.stockStatus,
          deletedAt: schema.products.deletedAt,
        })
        .from(schema.products)
        .where(inArray(schema.products.id, wantedIds))
        .for("update");

      const byId = new Map(products.map((p) => [p.id, p]));

      // 2. Every requested id must resolve to a live, in-stock product. A
      //    stale client cart (product deleted or sold out since the page
      //    loaded) surfaces as 409 with the offending ids so the FE can prune.
      const unavailable: { path: string; message: string }[] = [];
      for (const id of wantedIds) {
        const p = byId.get(id);
        if (!p || p.deletedAt !== null) {
          unavailable.push({ path: id, message: "Product is no longer available." });
        } else if (p.stockStatus === "out_of_stock") {
          unavailable.push({ path: p.code, message: `${p.name} is out of stock.` });
        }
      }
      if (unavailable.length === wantedIds.length) {
        // Nothing purchasable at all.
        throw new ApiError({
          type: "/problems/cart-empty",
          title: "Cart Empty",
          status: 422,
          detail: "None of the requested products are available.",
        });
      }
      if (unavailable.length > 0) {
        throw new ApiError({
          type: "/problems/out-of-stock",
          title: "Some Items Unavailable",
          status: 409,
          detail:
            "One or more items are no longer available. Remove them and try again.",
          errors: unavailable,
        });
      }

      // 3. Money — integer cents only.
      const live = wantedIds.map((id) => ({
        product: byId.get(id)!,
        quantity: wanted.get(id)!,
      }));
      const subtotalCents = live.reduce(
        (sum, l) => sum + Number(l.product.priceCents) * l.quantity,
        0,
      );
      // Guests have no account → no per-account discount.
      const discountAmountCents = 0;
      const totalCents = subtotalCents;
      const currency = live[0]!.product.currency;

      // 4. Atomic public order number.
      const numRows = await tx.execute(sql`
        SELECT
          to_char(now() AT TIME ZONE 'Europe/Sofia', 'YYYY-MM')
            || '-' || lpad(nextval('orders_order_number_seq')::text, 5, '0')
            AS order_number
      `);
      const numRow = pickFirstRow<{ order_number: string }>(numRows);
      if (!numRow) throw internal("Failed to generate orderNumber");
      const orderNumber = numRow.order_number;

      // 5. Insert the order header — customerId NULL marks it a guest order.
      const trackToken = issueGuestTrackToken();
      const [order] = await tx
        .insert(schema.orders)
        .values({
          orderNumber,
          customerId: null,
          idempotencyKey,
          guestTrackToken: trackToken,
          status: "processing",
          paymentMethod: body.paymentMethod,
          customerEmail: body.contact.email,
          customerName: body.contact.name,
          customerPhone: phone,
          subtotalCents: String(subtotalCents),
          discountPercent: "0",
          discountAmountCents: String(discountAmountCents),
          totalCents: String(totalCents),
          notes: body.notes ?? null,
        })
        .returning();
      if (!order) throw internal("Failed to insert order");

      // 6. Line items, with the primary-image snapshot (same lookup as the
      //    authenticated path).
      const primaryImages = new Map<string, { s3Key: string; altText: string }>();
      const imgRows = await tx
        .select({
          productId: schema.productImages.productId,
          s3Key: schema.productImages.s3Key,
          altText: schema.productImages.altText,
        })
        .from(schema.productImages)
        .where(inArray(schema.productImages.productId, wantedIds))
        .orderBy(
          schema.productImages.productId,
          schema.productImages.displayOrder,
          schema.productImages.id,
        );
      for (const r of imgRows) {
        if (!primaryImages.has(r.productId)) {
          primaryImages.set(r.productId, { s3Key: r.s3Key, altText: r.altText });
        }
      }
      const insertedItems = await tx
        .insert(schema.orderItems)
        .values(
          live.map((l) => ({
            orderId: order.id,
            productId: l.product.id,
            productCode: l.product.code,
            productName: l.product.name,
            productImageS3Key: primaryImages.get(l.product.id)?.s3Key ?? null,
            unitPriceCents: String(l.product.priceCents),
            quantity: l.quantity,
            discountAmountCents: "0",
          })),
        )
        .returning();

      // 7. Status-history seed. changedByUserId NULL = system/guest.
      await tx.insert(schema.orderStatusHistory).values({
        orderId: order.id,
        status: "processing",
        changedByUserId: null,
        note: null,
      });

      // 8. Delivery-address snapshot (cash_on_delivery only).
      if (body.paymentMethod === "cash_on_delivery" && body.deliveryAddress) {
        await tx.insert(schema.orderDeliveryAddress).values({
          orderId: order.id,
          city: body.deliveryAddress.city,
          postalCode: body.deliveryAddress.postalCode,
          street: body.deliveryAddress.street,
          apartmentOrOffice: body.deliveryAddress.apartmentOrOffice ?? null,
        });
      }

      return shapeGuestOrder({
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
        currency,
        trackToken,
      });
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "23505") {
      const won = await findGuestOrderByIdempotencyKey(db, idempotencyKey);
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

  // ─ Order-confirmation email with the durable tracking link ────────────────
  const env = parseEnv();
  await sendOrderConfirmationEmail({
    to: placed.customerEmail,
    customerName: placed.customerName,
    orderNumber: placed.orderNumber,
    placedAt: new Date(placed.createdAt),
    paymentMethod: placed.paymentMethod,
    items: placed.items.map((it) => ({
      productCode: it.productCode,
      productName: it.productName,
      quantity: it.quantity,
      unitPriceCents: it.unitPriceCents,
    })),
    subtotalCents: placed.subtotalCents,
    discountPercent: 0,
    discountAmountCents: placed.discountAmountCents,
    totalCents: placed.totalCents,
    currency: placed.currency,
    deliveryAddress: placed.deliveryAddress,
    orderUrl: trackUrl(env.PUBLIC_APP_BASE_URL, placed.trackToken),
    logger: baseLogger,
  });

  return c.json(placed, 201);
});

trackRoutes.openapi(getTrackRoute, async (c) => {
  const { token } = c.req.valid("param");
  const db = getDb();
  const order = await resolveOrderByToken(db, token);
  if (!order) throw notFound("Order not found.");
  return c.json(await loadTrackedOrder(db, order), 200);
});

trackRoutes.openapi(cancelTrackRoute, async (c) => {
  const { token } = c.req.valid("param");
  const db = getDb();
  const order = await resolveOrderByToken(db, token);
  if (!order) throw notFound("Order not found.");

  const result = await cancelOrderByCustomer(db, {
    orderId: order.id,
    actorUserId: null,
    reason: "Анулирана от госта",
  });

  if (!result.ok) {
    if (result.reason === "not_found") throw notFound("Order not found.");
    throw new ApiError({
      type: "/problems/order-not-cancellable",
      title: "Order Cannot Be Cancelled",
      status: 422,
      detail:
        "This order can no longer be cancelled online. It has moved past 'processing' — please contact the shop.",
    });
  }

  // Best-effort cancellation notice with the durable tracking link.
  const env = parseEnv();
  await sendOrderStatusUpdateEmail({
    to: result.order.customerEmail,
    customerName: result.order.customerName,
    orderNumber: result.order.orderNumber,
    status: "cancelled",
    changedAt: new Date(),
    cancelledReason: result.order.cancelledReason,
    orderUrl: trackUrl(env.PUBLIC_APP_BASE_URL, token),
    logger: baseLogger,
  });

  return c.json(await loadTrackedOrder(db, result.order), 200);
});

trackRoutes.openapi(getTrackWithdrawalEligibilityRoute, async (c) => {
  const { token } = c.req.valid("param");
  const db = getDb();
  const order = await resolveOrderByToken(db, token);
  if (!order) throw notFound("Order not found.");

  const e = await evaluateWithdrawalEligibilityForOrder(db, {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    acceptedAt: order.acceptedAt,
  });

  if (!e.eligible) {
    const reason: "window_expired" | "not_accepted" =
      e.reason === "window_expired" ? "window_expired" : "not_accepted";
    return c.json(
      { eligible: false as const, reason, windowDays: WITHDRAWAL_WINDOW_DAYS },
      200,
    );
  }
  return c.json(
    {
      eligible: true as const,
      acceptedAt: e.acceptedAt.toISOString(),
      deadlineAt: e.deadlineAt.toISOString(),
      alreadySubmittedAt: e.alreadySubmittedAt
        ? e.alreadySubmittedAt.toISOString()
        : null,
      windowDays: WITHDRAWAL_WINDOW_DAYS,
    },
    200,
  );
});

trackRoutes.openapi(postTrackWithdrawalRoute, async (c) => {
  const { token } = c.req.valid("param");
  let body: z.infer<typeof WithdrawalRequestBodySchema>;
  try {
    body = c.req.valid("json");
  } catch {
    body = {};
  }
  const db = getDb();
  const order = await resolveOrderByToken(db, token);
  if (!order) throw notFound("Order not found.");

  const e = await evaluateWithdrawalEligibilityForOrder(db, {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    acceptedAt: order.acceptedAt,
  });
  if (!e.eligible) {
    if (e.reason === "window_expired") {
      throw new ApiError({
        type: "/problems/withdrawal-window-expired",
        title: "Withdrawal Window Expired",
        status: 422,
        detail: `The 14-day withdrawal window for order ${order.orderNumber} has expired.`,
      });
    }
    throw new ApiError({
      type: "/problems/withdrawal-not-accepted",
      title: "Withdrawal Not Available",
      status: 422,
      detail: `Order ${order.orderNumber} must be in 'accepted' status before a withdrawal can be submitted.`,
    });
  }

  const description = body.reason && body.reason.length > 0 ? body.reason : null;
  const { record, created } = await createOrFetchWithdrawalRecord(db, {
    orderId: order.id,
    customerEmail: order.customerEmail,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    description,
  });

  if (created) {
    const env = parseEnv();
    const support = deriveSupportEmail(env.EMAIL_FROM);
    const [customerResult] = await Promise.allSettled([
      sendWithdrawalAcknowledgementEmail({
        to: record.customerEmail,
        customerName: record.customerName,
        orderNumber: order.orderNumber,
        submittedAt: record.submittedAt,
        description: record.description,
        logger: baseLogger,
      }),
      sendWithdrawalAdminNotificationEmail({
        to: support,
        orderNumber: order.orderNumber,
        submittedAt: record.submittedAt,
        customerEmail: record.customerEmail,
        customerName: record.customerName,
        customerPhone: record.customerPhone,
        description: record.description,
        logger: baseLogger,
      }),
    ]);
    if (customerResult.status === "fulfilled" && customerResult.value === true) {
      const ackAt = await markWithdrawalAcknowledged(db, record.id);
      if (ackAt) record.acknowledgedAt = ackAt;
    } else {
      baseLogger.warn(
        { orderNumber: order.orderNumber, withdrawalId: record.id },
        "withdrawal_customer_ack_email_failed",
      );
    }
  }

  return c.json(
    shapeTrackWithdrawalRecord(record, order.orderNumber),
    created ? 201 : 200,
  );
});

trackRoutes.openapi(findOrderRoute, async (c) => {
  const body = c.req.valid("json");
  const db = getDb();
  const ip = clientIpFromXff(c.req.header("x-forwarded-for"));

  if (!findLimiter.hit(ip).allowed) {
    throw new ApiError({
      type: "/problems/find-rate-limited",
      title: "Too Many Requests",
      status: 429,
      detail: "Too many lookup attempts. Please try again in an hour.",
    });
  }

  // Guest orders ONLY (customerId IS NULL), matched on number + email. The
  // response is identical whether or not a row matched — we never confirm an
  // order's existence or an email's correctness (spec §7 + enumeration
  // resistance). On a match we re-send the confirmation email, which carries
  // the durable /track link.
  const [order] = await db
    .select()
    .from(schema.orders)
    .where(
      and(
        eq(schema.orders.orderNumber, body.orderNumber),
        // body.email is already lower-cased by the schema transform.
        sql`lower(${schema.orders.customerEmail}) = ${body.email}`,
        isNull(schema.orders.customerId),
      ),
    )
    .limit(1);

  if (order && order.guestTrackToken) {
    await resendGuestTrackEmail(db, order).catch((err) => {
      baseLogger.warn({ err }, "guest_track_resend_failed");
    });
  } else {
    baseLogger.info({ matched: false }, "guest_track_find_no_match");
  }

  return c.json({ ok: true as const }, 200);
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build the durable capability URL for an order's email/link. */
function trackUrl(baseUrl: string, token: string): string {
  return `${baseUrl}/track/${token}`;
}

/**
 * Resolve a full order row from a tracking token. Rejects malformed tokens up
 * front with `null` (→ uniform 404) so we never run a pointless query, and
 * never log the token itself.
 */
async function resolveOrderByToken(
  db: DbClient,
  token: string,
): Promise<typeof schema.orders.$inferSelect | null> {
  if (!isWellFormedTrackToken(token)) return null;
  const [order] = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.guestTrackToken, token))
    .limit(1);
  return order ?? null;
}

async function findGuestOrderByIdempotencyKey(
  db: DbClient,
  idempotencyKey: string,
): Promise<z.infer<typeof GuestOrderSchema> | null> {
  const [order] = await db
    .select()
    .from(schema.orders)
    .where(
      and(
        eq(schema.orders.idempotencyKey, idempotencyKey),
        isNull(schema.orders.customerId),
      ),
    )
    .limit(1);
  if (!order || !order.guestTrackToken) return null;

  const items = await db
    .select()
    .from(schema.orderItems)
    .where(eq(schema.orderItems.orderId, order.id));
  const [delivery] = await db
    .select()
    .from(schema.orderDeliveryAddress)
    .where(eq(schema.orderDeliveryAddress.orderId, order.id))
    .limit(1);

  return shapeGuestOrder({
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
    currency: "EUR",
    trackToken: order.guestTrackToken,
  });
}

/** Hydrate the rich tracked-order DTO (adds courier/pickup + timeline). */
async function loadTrackedOrder(
  db: DbClient,
  order: typeof schema.orders.$inferSelect,
): Promise<z.infer<typeof TrackedOrderSchema>> {
  const [items, [delivery], history] = await Promise.all([
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
      .select({
        status: schema.orderStatusHistory.status,
        changedAt: schema.orderStatusHistory.changedAt,
      })
      .from(schema.orderStatusHistory)
      .where(eq(schema.orderStatusHistory.orderId, order.id))
      .orderBy(asc(schema.orderStatusHistory.changedAt)),
  ]);

  const env = parseEnv();
  return {
    orderNumber: order.orderNumber,
    status: order.status,
    paymentMethod: order.paymentMethod,
    createdAt: order.createdAt.toISOString(),
    acceptedAt: order.acceptedAt ? order.acceptedAt.toISOString() : null,
    customerName: order.customerName,
    customerEmail: order.customerEmail,
    customerPhone: order.customerPhone,
    items: items.map((it) => ({
      productName: it.productName,
      productCode: it.productCode,
      productImageUrl: it.productImageS3Key
        ? buildImageUrl(it.productImageS3Key)
        : null,
      unitPriceCents: Number(it.unitPriceCents),
      quantity: it.quantity,
    })),
    subtotalCents: Number(order.subtotalCents),
    discountAmountCents: Number(order.discountAmountCents),
    totalCents: Number(order.totalCents),
    currency: "EUR",
    deliveryAddress: delivery
      ? {
          city: delivery.city,
          postalCode: delivery.postalCode,
          street: delivery.street,
          apartmentOrOffice: delivery.apartmentOrOffice ?? null,
        }
      : null,
    courierCompany: order.courierCompany ?? null,
    trackingNumber: order.trackingNumber ?? null,
    pickupDeadline: order.pickupDeadline ? order.pickupDeadline.toISOString() : null,
    statusHistory: history.map((h) => ({
      status: h.status,
      changedAt: h.changedAt.toISOString(),
    })),
    shopContact: {
      email: deriveSupportEmail(env.EMAIL_FROM),
      phone: env.SHOP_CONTACT_PHONE.length > 0 ? env.SHOP_CONTACT_PHONE : null,
    },
    canCancel: order.status === "processing",
  };
}

/** Re-send the order-confirmation email (carrying the /track link) for find-my-order. */
async function resendGuestTrackEmail(
  db: DbClient,
  order: typeof schema.orders.$inferSelect,
): Promise<void> {
  if (!order.guestTrackToken) return;
  const env = parseEnv();
  const items = await db
    .select()
    .from(schema.orderItems)
    .where(eq(schema.orderItems.orderId, order.id));
  const [delivery] = await db
    .select()
    .from(schema.orderDeliveryAddress)
    .where(eq(schema.orderDeliveryAddress.orderId, order.id))
    .limit(1);

  await sendOrderConfirmationEmail({
    to: order.customerEmail,
    customerName: order.customerName,
    orderNumber: order.orderNumber,
    placedAt: order.createdAt,
    paymentMethod: order.paymentMethod,
    items: items.map((it) => ({
      productCode: it.productCode,
      productName: it.productName,
      quantity: it.quantity,
      unitPriceCents: Number(it.unitPriceCents),
    })),
    subtotalCents: Number(order.subtotalCents),
    discountPercent: Number(order.discountPercent),
    discountAmountCents: Number(order.discountAmountCents),
    totalCents: Number(order.totalCents),
    currency: "EUR",
    deliveryAddress: delivery
      ? {
          city: delivery.city,
          postalCode: delivery.postalCode,
          street: delivery.street,
          apartmentOrOffice: delivery.apartmentOrOffice ?? null,
        }
      : null,
    orderUrl: trackUrl(env.PUBLIC_APP_BASE_URL, order.guestTrackToken),
    logger: baseLogger,
  });
}

function shapeGuestOrder(input: {
  order: typeof schema.orders.$inferSelect;
  items: (typeof schema.orderItems.$inferSelect)[];
  deliveryAddress: {
    city: string;
    postalCode: string;
    street: string;
    apartmentOrOffice: string | null;
  } | null;
  currency: string;
  trackToken: string;
}): z.infer<typeof GuestOrderSchema> {
  const { order, items, deliveryAddress, currency, trackToken } = input;
  return {
    orderNumber: order.orderNumber,
    status: order.status,
    paymentMethod: order.paymentMethod,
    createdAt: order.createdAt.toISOString(),
    customerName: order.customerName,
    customerEmail: order.customerEmail,
    customerPhone: order.customerPhone,
    items: items.map((it) => ({
      productName: it.productName,
      productCode: it.productCode,
      productImageUrl: it.productImageS3Key
        ? buildImageUrl(it.productImageS3Key)
        : null,
      unitPriceCents: Number(it.unitPriceCents),
      quantity: it.quantity,
    })),
    subtotalCents: Number(order.subtotalCents),
    discountAmountCents: Number(order.discountAmountCents),
    totalCents: Number(order.totalCents),
    currency,
    deliveryAddress,
    trackToken,
    trackPath: `/track/${trackToken}`,
  };
}

function shapeTrackWithdrawalRecord(
  record: WithdrawalRecord,
  orderNumber: string,
): z.infer<typeof TrackWithdrawalRecordSchema> {
  return {
    id: record.id,
    orderNumber,
    reason: record.description,
    submittedAt: record.submittedAt.toISOString(),
    acknowledgedAt: record.acknowledgedAt
      ? record.acknowledgedAt.toISOString()
      : null,
  };
}

/** Driver-portable first-row pick for raw `db.execute()` (see orders.ts). */
function pickFirstRow<T>(result: unknown): T | null {
  if (Array.isArray(result)) return (result[0] as T | undefined) ?? null;
  const r = result as { rows?: unknown[] } | null | undefined;
  if (r && Array.isArray(r.rows)) return (r.rows[0] as T | undefined) ?? null;
  return null;
}

// ─── Public type surface (re-exported from src/types.ts for the frontend) ────

export type GuestOrder = z.infer<typeof GuestOrderSchema>;
export type TrackedOrder = z.infer<typeof TrackedOrderSchema>;
export type TrackOrderItem = z.infer<typeof TrackOrderItemSchema>;
export type TrackWithdrawalEligibility = z.infer<
  typeof TrackWithdrawalEligibilitySchema
>;
export type TrackWithdrawalRecord = z.infer<typeof TrackWithdrawalRecordSchema>;
