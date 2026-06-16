import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { schema, type DbClient } from "@shop/db";
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Logger } from "pino";
import { getDb } from "../../lib/db.js";
import { parseEnv } from "../../lib/env.js";
import { ApiError, ProblemSchema, badRequest, notFound } from "../../lib/errors.js";
import { buildImageUrl } from "../../lib/images.js";
import { logger as baseLogger } from "../../lib/logger.js";
import { sendOrderStatusUpdateEmail } from "../../lib/order-emails.js";
import {
  allowedTargets,
  canTransition,
  isCustomerNotifiableStatus,
  requiredFieldsForTarget,
  TRANSITION_TARGETS,
  type OrderStatus,
  type TransitionTarget,
} from "../../lib/order-status.js";
import { validationHook } from "../../lib/validation-hook.js";
import { requireAdmin } from "../../middleware/admin.js";
import type { AuthVariables } from "../../middleware/auth.js";

/**
 * Admin order management — the first real admin CRUD slice
 * (docs/ARCHITECTURE.md §15 item 22; docs/README.md §"Управление на поръчки").
 *
 * Surface (all behind `requireAdmin` — non-admins get the uniform 404):
 *
 *   GET  /admin/orders                    paged list + filters + search
 *   GET  /admin/orders/export.csv        CSV export honouring the same filters
 *   GET  /admin/orders/:orderNumber      full detail incl. status history
 *   POST /admin/orders/:orderNumber/status   state-machine transition
 *
 * Design notes (researched against 2026 practice, see ARCHITECTURE §13):
 *
 *   - **Explicit state machine.** Transitions validate against the full
 *     table in `lib/order-status.ts` (1:1 with spec §7) — never a free-form
 *     status write. An illegal hop is a 409 `/problems/invalid-status-transition`
 *     (it conflicts with the CURRENT state of the resource; a 422 would imply
 *     the request could never be valid).
 *   - **Optimistic locking.** The spec mandates a version check ("Защита от
 *     конкурентни действия"). The client echoes `expectedVersion`; the UPDATE
 *     carries `WHERE version = expectedVersion` so a concurrent admin tab
 *     loses cleanly → 409 `/problems/order-version-conflict`, and the UI
 *     refreshes. (Version-in-payload over `If-Match` ETags: the order DTO
 *     already carries `version` for the spec's UI contract, and the CDN in
 *     front of this API plays ETag games of its own on GETs.)
 *   - **Offset pagination, not cursor.** Deliberate divergence from the
 *     public catalog (ARCHITECTURE §13): a back-office table needs a total
 *     count and "page N of M" jumps (spec: 25/page, buttons top + bottom).
 *     Offset's drift-under-insert weakness is acceptable for a single-admin
 *     list ordered by `created_at DESC` with a composite index behind it.
 *   - **Audit trail.** Every transition appends to `order_status_history`
 *     (who, when, optional note) inside the SAME transaction as the UPDATE —
 *     the log cannot disagree with the row.
 *   - **Customer notification.** After commit, the matching Bulgarian
 *     `orders.order-status-update` email fires best-effort (never blocks or
 *     rolls back the transition; `returned` is internal-only by design).
 *   - **CSV export per OWASP.** Every field is quoted; fields beginning with
 *     `=`, `+`, `-`, `@`, TAB or CR are prefixed with a TAB so spreadsheet
 *     apps render them as text instead of executing formulas (CSV/formula
 *     injection); UTF-8 BOM so Excel decodes Cyrillic correctly.
 */

type AdminOrdersVariables = AuthVariables & {
  logger: Logger;
  requestId: string;
};

export const adminOrdersRoutes = new OpenAPIHono<{
  Variables: AdminOrdersVariables;
}>({
  defaultHook: validationHook,
});

// currentUser is applied in app.ts (it resolves the cookie); requireAdmin
// turns everything below into a flat 404 for non-admins — same posture as
// /admin/auth/me, so the admin surface stays unconfirmable.
adminOrdersRoutes.use("*", requireAdmin);

// ─── DTOs ────────────────────────────────────────────────────────────────────

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
  .openapi("AdminOrderStatus");

const PaymentMethodSchema = z
  .enum(["cash_on_delivery", "pay_at_store"])
  .openapi("AdminPaymentMethod");

const CustomerTypeSchema = z
  .enum(["guest", "personal", "corporate"])
  .openapi("AdminOrderCustomerType");

const TransitionTargetSchema = z
  .enum(TRANSITION_TARGETS)
  .openapi("AdminOrderTransitionTarget");

const AdminOrderSummarySchema = z
  .object({
    id: z.string().uuid(),
    orderNumber: z.string(),
    status: OrderStatusSchema,
    paymentMethod: PaymentMethodSchema,
    customerType: CustomerTypeSchema,
    customerEmail: z.string(),
    customerName: z.string(),
    customerPhone: z.string(),
    /** Corporate orders only — company on the snapshot, else null. */
    companyName: z.string().nullable(),
    totalCents: z.number().int().nonnegative(),
    currency: z.string(),
    /** Optimistic-locking version — echo back on POST …/status. */
    version: z.number().int().positive(),
    /** Non-null only for ready_for_pickup; powers the expired-deadline mark. */
    pickupDeadline: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("AdminOrderSummary");

const AdminOrdersPageSchema = z
  .object({
    items: z.array(AdminOrderSummarySchema),
    /** Total rows matching the filters (across all pages). */
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
    totalPages: z.number().int().nonnegative(),
  })
  .openapi("AdminOrdersPage");

const AdminOrderItemSchema = z
  .object({
    productId: z.string().uuid().nullable(),
    productCode: z.string(),
    productName: z.string(),
    productImageUrl: z.string().url().nullable(),
    unitPriceCents: z.number().int().nonnegative(),
    quantity: z.number().int().positive(),
    discountAmountCents: z.number().int().nonnegative(),
  })
  .openapi("AdminOrderItem");

const AdminStatusHistoryEntrySchema = z
  .object({
    id: z.string().uuid(),
    status: OrderStatusSchema,
    changedAt: z.string(),
    /** Admin/customer who made the change; null = system (e.g. checkout seed). */
    changedByUserId: z.string().uuid().nullable(),
    /** Live e-mail of the changer, when the account still exists. */
    changedByEmail: z.string().nullable(),
    note: z.string().nullable(),
  })
  .openapi("AdminOrderStatusHistoryEntry");

const AdminOrderDetailSchema = AdminOrderSummarySchema.extend({
  customerId: z.string().uuid().nullable(),
  subtotalCents: z.number().int().nonnegative(),
  discountPercent: z.number().nonnegative(),
  discountAmountCents: z.number().int().nonnegative(),
  items: z.array(AdminOrderItemSchema),
  deliveryAddress: z
    .object({
      city: z.string(),
      postalCode: z.string(),
      street: z.string(),
      apartmentOrOffice: z.string().nullable(),
    })
    .nullable(),
  corporateData: z
    .object({
      companyName: z.string(),
      eik: z.string(),
      vatNumber: z.string().nullable(),
      registeredAddress: z.string(),
      mol: z.string(),
      contactName: z.string(),
    })
    .nullable(),
  courierCompany: z.string().nullable(),
  trackingNumber: z.string().nullable(),
  cancelledReason: z.string().nullable(),
  notes: z.string().nullable(),
  acceptedAt: z.string().nullable(),
  statusHistory: z.array(AdminStatusHistoryEntrySchema),
  /**
   * Server-computed legal next statuses for THIS order (current status ×
   * payment method). The UI renders exactly these action buttons — the
   * transition table lives server-side only.
   */
  allowedTargets: z.array(TransitionTargetSchema),
}).openapi("AdminOrderDetail");

export type AdminOrderSummary = z.infer<typeof AdminOrderSummarySchema>;
export type AdminOrdersPage = z.infer<typeof AdminOrdersPageSchema>;
export type AdminOrderDetail = z.infer<typeof AdminOrderDetailSchema>;
export type AdminOrderStatusHistoryEntry = z.infer<
  typeof AdminStatusHistoryEntrySchema
>;

// ─── Query / body schemas ────────────────────────────────────────────────────

const DateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

const ListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  /** Spec default is 25 per page; capped to keep the hydration bounded. */
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: OrderStatusSchema.optional(),
  paymentMethod: PaymentMethodSchema.optional(),
  customerType: CustomerTypeSchema.optional(),
  /** Matches order number, customer e-mail, phone, or company name. */
  q: z.string().trim().min(1).max(200).optional(),
  /** Inclusive lower bound, Europe/Sofia calendar date. */
  from: DateOnlySchema.optional(),
  /** Inclusive upper bound, Europe/Sofia calendar date. */
  to: DateOnlySchema.optional(),
});

const OrderNumberParamSchema = z.object({
  orderNumber: z
    .string()
    .min(1)
    .max(40)
    .openapi({ example: "2026-06-00042" }),
});

const TransitionBodySchema = z
  .object({
    status: TransitionTargetSchema,
    /**
     * The `version` the admin's screen was rendered from. The transition
     * only applies if the row still carries it (optimistic locking).
     */
    expectedVersion: z.number().int().positive(),
    /** Mandatory when status = shipped. */
    courierCompany: z.string().trim().min(1).max(120).optional(),
    /** Mandatory when status = shipped. */
    trackingNumber: z.string().trim().min(1).max(120).optional(),
    /** Mandatory when status = ready_for_pickup; ISO 8601, must be future. */
    pickupDeadline: z.iso.datetime({ offset: true }).optional(),
    /** Optional when status = cancelled; e-mailed to the customer verbatim. */
    cancelledReason: z.string().trim().min(1).max(500).optional(),
    /** Optional free-form audit note, stored on the history entry. */
    note: z.string().trim().min(1).max(1000).optional(),
  })
  .strict()
  .openapi("AdminOrderTransitionRequest");

// ─── Shared helpers ──────────────────────────────────────────────────────────

function orderNotFound(orderNumber: string): ApiError {
  return notFound(
    `No order with number ${orderNumber}.`,
    "/problems/order-not-found",
  );
}

/**
 * 409 for the optimistic-locking loss: the screen the admin acted from no
 * longer matches the row. The UI's contract (spec „Защита от конкурентни
 * действия") is to show „Поръчката е вече актуализирана…" and refresh.
 */
function orderVersionConflict(
  orderNumber: string,
  sentVersion: number,
  fresh: OrderRow | null,
): ApiError {
  return new ApiError({
    type: "/problems/order-version-conflict",
    title: "Order Was Updated Concurrently",
    status: 409,
    detail: fresh
      ? `Order ${orderNumber} changed since your screen loaded (now "${fresh.status}", version ${fresh.version}, you sent ${sentVersion}). Reload and retry.`
      : `Order ${orderNumber} changed since your screen loaded. Reload and retry.`,
  });
}

/**
 * WHERE parts + the corporate LEFT JOIN flag for the list/export filters.
 * The corporate snapshot join is needed whenever we filter or search on it;
 * the list SELECT joins it unconditionally anyway (companyName column).
 */
function buildListFilters(q: z.infer<typeof ListQuerySchema>): SQL[] {
  const parts: SQL[] = [];
  if (q.status) parts.push(eq(schema.orders.status, q.status));
  if (q.paymentMethod) {
    parts.push(eq(schema.orders.paymentMethod, q.paymentMethod));
  }
  if (q.customerType === "guest") {
    parts.push(isNull(schema.orders.customerId));
  } else if (q.customerType === "corporate") {
    parts.push(isNotNull(schema.orderCorporateData.orderId));
  } else if (q.customerType === "personal") {
    parts.push(isNotNull(schema.orders.customerId));
    parts.push(isNull(schema.orderCorporateData.orderId));
  }
  if (q.q) {
    const pattern = `%${q.q}%`;
    parts.push(
      or(
        ilike(schema.orders.orderNumber, pattern),
        ilike(schema.orders.customerEmail, pattern),
        ilike(schema.orders.customerPhone, pattern),
        ilike(schema.orderCorporateData.companyName, pattern),
      )!,
    );
  }
  // Calendar-date bounds in the shop's timezone. `'YYYY-MM-DD'::timestamp AT
  // TIME ZONE 'Europe/Sofia'` yields the UTC instant of Sofia midnight, so the
  // comparison stays sargable on the created_at index (no per-row conversion).
  if (q.from) {
    parts.push(
      sql`${schema.orders.createdAt} >= (${q.from}::timestamp AT TIME ZONE 'Europe/Sofia')`,
    );
  }
  if (q.to) {
    parts.push(
      sql`${schema.orders.createdAt} < (((${q.to}::date + 1)::timestamp) AT TIME ZONE 'Europe/Sofia')`,
    );
  }
  return parts;
}

type OrderRow = typeof schema.orders.$inferSelect;
type CorporateRow = typeof schema.orderCorporateData.$inferSelect;

function customerTypeOf(
  order: OrderRow,
  corporate: { orderId: string } | null,
): "guest" | "personal" | "corporate" {
  if (corporate) return "corporate";
  return order.customerId ? "personal" : "guest";
}

function shapeSummary(
  order: OrderRow,
  corporate: Pick<CorporateRow, "orderId" | "companyName"> | null,
): AdminOrderSummary {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentMethod: order.paymentMethod,
    customerType: customerTypeOf(order, corporate),
    customerEmail: order.customerEmail,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    companyName: corporate?.companyName ?? null,
    totalCents: Number(order.totalCents),
    currency: "EUR",
    version: order.version,
    pickupDeadline: order.pickupDeadline
      ? order.pickupDeadline.toISOString()
      : null,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}

/** Hydrate one order row into the full admin detail DTO. */
async function loadAdminOrderDetail(
  db: DbClient,
  order: OrderRow,
): Promise<AdminOrderDetail> {
  const [items, [delivery], [corp], history] = await Promise.all([
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
    db
      .select({
        id: schema.orderStatusHistory.id,
        status: schema.orderStatusHistory.status,
        changedAt: schema.orderStatusHistory.changedAt,
        changedByUserId: schema.orderStatusHistory.changedByUserId,
        note: schema.orderStatusHistory.note,
        changedByEmail: schema.users.email,
      })
      .from(schema.orderStatusHistory)
      .leftJoin(
        schema.users,
        eq(schema.orderStatusHistory.changedByUserId, schema.users.id),
      )
      .where(eq(schema.orderStatusHistory.orderId, order.id))
      .orderBy(
        asc(schema.orderStatusHistory.changedAt),
        asc(schema.orderStatusHistory.id),
      ),
  ]);

  const corporate = corp ?? null;
  return {
    ...shapeSummary(order, corporate),
    customerId: order.customerId ?? null,
    subtotalCents: Number(order.subtotalCents),
    discountPercent: Number(order.discountPercent),
    discountAmountCents: Number(order.discountAmountCents),
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
    deliveryAddress: delivery
      ? {
          city: delivery.city,
          postalCode: delivery.postalCode,
          street: delivery.street,
          apartmentOrOffice: delivery.apartmentOrOffice ?? null,
        }
      : null,
    corporateData: corporate
      ? {
          companyName: corporate.companyName,
          eik: corporate.eik,
          vatNumber: corporate.vatNumber ?? null,
          registeredAddress: corporate.registeredAddress,
          mol: corporate.mol,
          contactName: corporate.contactName,
        }
      : null,
    courierCompany: order.courierCompany ?? null,
    trackingNumber: order.trackingNumber ?? null,
    cancelledReason: order.cancelledReason ?? null,
    notes: order.notes ?? null,
    acceptedAt: order.acceptedAt ? order.acceptedAt.toISOString() : null,
    statusHistory: history.map((h) => ({
      id: h.id,
      status: h.status,
      changedAt: h.changedAt.toISOString(),
      changedByUserId: h.changedByUserId ?? null,
      changedByEmail: h.changedByEmail ?? null,
      note: h.note ?? null,
    })),
    allowedTargets: allowedTargets(order.status, order.paymentMethod),
  };
}

// ─── GET /admin/orders (paged list) ──────────────────────────────────────────

const listAdminOrdersRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["admin-orders"],
  summary: "List all orders — filterable, searchable, offset-paginated",
  request: { query: ListQuerySchema },
  responses: {
    200: {
      description: "One page of orders, newest first, plus the total count.",
      content: { "application/json": { schema: AdminOrdersPageSchema } },
    },
    404: {
      description: "Not an admin (uniform with an unknown route).",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminOrdersRoutes.openapi(listAdminOrdersRoute, async (c) => {
  const q = c.req.valid("query");
  const db = getDb();
  const filters = buildListFilters(q);
  const where = filters.length > 0 ? and(...filters) : undefined;

  const countRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.orders)
    .leftJoin(
      schema.orderCorporateData,
      eq(schema.orderCorporateData.orderId, schema.orders.id),
    )
    .where(where);
  const total = countRows[0]?.count ?? 0;

  const rows = await db
    .select({
      order: schema.orders,
      corporateOrderId: schema.orderCorporateData.orderId,
      companyName: schema.orderCorporateData.companyName,
    })
    .from(schema.orders)
    .leftJoin(
      schema.orderCorporateData,
      eq(schema.orderCorporateData.orderId, schema.orders.id),
    )
    .where(where)
    .orderBy(desc(schema.orders.createdAt), desc(schema.orders.id))
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);

  return c.json(
    {
      items: rows.map((r) =>
        shapeSummary(
          r.order,
          r.corporateOrderId
            ? { orderId: r.corporateOrderId, companyName: r.companyName! }
            : null,
        ),
      ),
      total,
      page: q.page,
      pageSize: q.pageSize,
      totalPages: Math.ceil(total / q.pageSize),
    },
    200,
  );
});

// ─── GET /admin/orders/export.csv ────────────────────────────────────────────
// Registered BEFORE /:orderNumber so the literal segment wins the match.

/** Hard cap on export size — a single-admin shop's full history fits well
 *  inside it; revisit with streaming if the shop ever outgrows it. */
const CSV_EXPORT_MAX_ROWS = 10_000;

const CSV_STATUS_LABELS: Record<OrderStatus, string> = {
  processing: "Обработва се",
  shipped: "Изпратена",
  ready_for_pickup: "Готова за вземане",
  delivered: "Доставена",
  accepted: "Приета",
  returned: "Върната",
  cancelled: "Отказана",
};

const CSV_PAYMENT_LABELS: Record<"cash_on_delivery" | "pay_at_store", string> = {
  cash_on_delivery: "Наложен платеж",
  pay_at_store: "Плащане на място",
};

const CSV_CUSTOMER_TYPE_LABELS: Record<"guest" | "personal" | "corporate", string> = {
  guest: "Гост",
  personal: "Физическо лице",
  corporate: "Фирма",
};

/**
 * OWASP CSV-injection hardening + RFC 4180 quoting:
 *  - every field is double-quoted, internal quotes doubled;
 *  - fields starting with `=`, `+`, `-`, `@`, TAB or CR get a TAB prefix so
 *    Excel/Sheets/Calc treat them as text, never as a formula. (OWASP's
 *    currently recommended escape; the tab is invisible in spreadsheet UIs.)
 */
function csvCell(value: string | number | null | undefined): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `\t${s}`;
  return `"${s.replaceAll('"', '""')}"`;
}

/** `2026-06-10 14:23` in Europe/Sofia — sorts correctly AND reads naturally. */
function csvSofiaTimestamp(d: Date): string {
  // sv-SE locale renders ISO-like "YYYY-MM-DD HH:mm:ss"; trim the seconds.
  return d.toLocaleString("sv-SE", { timeZone: "Europe/Sofia" }).slice(0, 16);
}

function csvEur(cents: number): string {
  return (cents / 100).toFixed(2);
}

const exportCsvRoute = createRoute({
  method: "get",
  path: "/export.csv",
  tags: ["admin-orders"],
  summary: "Export the (filtered) order list as UTF-8 CSV",
  request: {
    // Same filters as the list — the export mirrors what the admin sees.
    query: ListQuerySchema.omit({ page: true, pageSize: true }),
  },
  responses: {
    200: {
      description:
        "CSV (RFC 4180, UTF-8 with BOM, formula-injection-escaped) of every order matching the filters, newest first.",
      content: { "text/csv": { schema: z.string() } },
    },
    404: {
      description: "Not an admin (uniform with an unknown route).",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminOrdersRoutes.openapi(exportCsvRoute, async (c) => {
  const q = { ...c.req.valid("query"), page: 1, pageSize: CSV_EXPORT_MAX_ROWS };
  const db = getDb();
  const filters = buildListFilters(q);
  const where = filters.length > 0 ? and(...filters) : undefined;

  const rows = await db
    .select({
      order: schema.orders,
      corporateOrderId: schema.orderCorporateData.orderId,
      companyName: schema.orderCorporateData.companyName,
    })
    .from(schema.orders)
    .leftJoin(
      schema.orderCorporateData,
      eq(schema.orderCorporateData.orderId, schema.orders.id),
    )
    .where(where)
    .orderBy(desc(schema.orders.createdAt), desc(schema.orders.id))
    .limit(CSV_EXPORT_MAX_ROWS);

  // Batch the side tables in two IN-list queries instead of 2×N round-trips.
  const ids = rows.map((r) => r.order.id);
  const [allItems, allAddresses] = ids.length
    ? await Promise.all([
        db
          .select()
          .from(schema.orderItems)
          .where(inArray(schema.orderItems.orderId, ids)),
        db
          .select()
          .from(schema.orderDeliveryAddress)
          .where(inArray(schema.orderDeliveryAddress.orderId, ids)),
      ])
    : [[], []];
  const itemsByOrder = new Map<string, (typeof allItems)[number][]>();
  for (const it of allItems) {
    const list = itemsByOrder.get(it.orderId) ?? [];
    list.push(it);
    itemsByOrder.set(it.orderId, list);
  }
  const addressByOrder = new Map(allAddresses.map((a) => [a.orderId, a]));

  const header = [
    "Номер",
    "Дата",
    "Тип клиент",
    "Клиент",
    "Имейл",
    "Телефон",
    "Фирма",
    "Продукти",
    "Междинна сума (EUR)",
    "Отстъпка (EUR)",
    "Обща сума (EUR)",
    "Начин на плащане",
    "Адрес за доставка",
    "Статус",
  ];

  const lines = [header.map(csvCell).join(",")];
  for (const r of rows) {
    const o = r.order;
    const corporate = r.corporateOrderId
      ? { orderId: r.corporateOrderId, companyName: r.companyName! }
      : null;
    const items = itemsByOrder.get(o.id) ?? [];
    const addr = addressByOrder.get(o.id);
    lines.push(
      [
        csvCell(o.orderNumber),
        csvCell(csvSofiaTimestamp(o.createdAt)),
        csvCell(CSV_CUSTOMER_TYPE_LABELS[customerTypeOf(o, corporate)]),
        csvCell(o.customerName),
        csvCell(o.customerEmail),
        csvCell(o.customerPhone),
        csvCell(corporate?.companyName ?? ""),
        csvCell(
          items
            .map(
              (it) =>
                `${it.productCode} × ${it.quantity} ${it.productName} @ ${csvEur(Number(it.unitPriceCents))}`,
            )
            .join(" | "),
        ),
        csvCell(csvEur(Number(o.subtotalCents))),
        csvCell(csvEur(Number(o.discountAmountCents))),
        csvCell(csvEur(Number(o.totalCents))),
        csvCell(CSV_PAYMENT_LABELS[o.paymentMethod]),
        csvCell(
          addr
            ? `${addr.street}${addr.apartmentOrOffice ? `, ${addr.apartmentOrOffice}` : ""}, ${addr.postalCode} ${addr.city}`
            : "",
        ),
        csvCell(CSV_STATUS_LABELS[o.status]),
      ].join(","),
    );
  }

  // ﻿ = UTF-8 BOM — without it Excel guesses a legacy code page and
  // renders the Cyrillic headers as mojibake. CRLF per RFC 4180. (Note for
  // tests: WHATWG `Response.text()` strips a leading BOM during decode —
  // assert on the raw bytes, not the decoded string.)
  const csv = "﻿" + lines.join("\r\n") + "\r\n";
  const today = new Date().toLocaleDateString("sv-SE", {
    timeZone: "Europe/Sofia",
  });
  return c.body(csv, 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="orders-export-${today}.csv"`,
    "Cache-Control": "no-store",
  });
});

// ─── GET /admin/orders/:orderNumber (detail) ─────────────────────────────────

const getAdminOrderRoute = createRoute({
  method: "get",
  path: "/{orderNumber}",
  tags: ["admin-orders"],
  summary: "Full order detail incl. items, snapshots, and status history",
  request: { params: OrderNumberParamSchema },
  responses: {
    200: {
      description: "The order, with `allowedTargets` for the action buttons.",
      content: { "application/json": { schema: AdminOrderDetailSchema } },
    },
    404: {
      description:
        "Unknown order number (`/problems/order-not-found`) — or not an admin.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminOrdersRoutes.openapi(getAdminOrderRoute, async (c) => {
  const { orderNumber } = c.req.valid("param");
  const db = getDb();
  const [order] = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.orderNumber, orderNumber))
    .limit(1);
  if (!order) throw orderNotFound(orderNumber);
  return c.json(await loadAdminOrderDetail(db, order), 200);
});

// ─── POST /admin/orders/:orderNumber/status (state-machine transition) ───────

const transitionRoute = createRoute({
  method: "post",
  path: "/{orderNumber}/status",
  tags: ["admin-orders"],
  summary: "Transition an order to its next status (validated state machine)",
  description:
    "Applies one hop of the docs/README.md §7 lifecycle. Requires the " +
    "`expectedVersion` the admin's screen was rendered from (optimistic " +
    "locking); appends an `order_status_history` audit entry in the same " +
    "transaction; then best-effort sends the Bulgarian status-update e-mail " +
    "for customer-visible transitions (everything except `returned`).",
  request: {
    params: OrderNumberParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: TransitionBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Transition applied — the fresh order detail.",
      content: { "application/json": { schema: AdminOrderDetailSchema } },
    },
    400: {
      description:
        "Missing/invalid companion fields for the target status (e.g. no trackingNumber for `shipped`, pickupDeadline in the past).",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    404: {
      description:
        "Unknown order number (`/problems/order-not-found`) — or not an admin.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    409: {
      description:
        "`/problems/invalid-status-transition` — the hop is not legal from the order's current status / payment method; or `/problems/order-version-conflict` — another session already changed the order (refetch and retry).",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminOrdersRoutes.openapi(transitionRoute, async (c) => {
  const { orderNumber } = c.req.valid("param");
  const body = c.req.valid("json");
  const admin = c.get("user")!; // requireAdmin guarantees presence + role
  const log = c.get("logger") ?? baseLogger;
  const db = getDb();
  const to = body.status;

  const [order] = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.orderNumber, orderNumber))
    .limit(1);
  if (!order) throw orderNotFound(orderNumber);

  // ─ Optimistic-locking pre-check ────────────────────────────────────────
  // If the version the admin's screen rendered from no longer matches the
  // row, the screen is PROVABLY stale — surface the version conflict, not an
  // invalid-transition complaint about a state the admin never saw. (The
  // UPDATE below still pins version + status; this pre-check only classifies
  // the common stale-tab case. The WHERE clause stays the authoritative
  // guard for the read-to-write race window.)
  if (body.expectedVersion !== order.version) {
    throw orderVersionConflict(orderNumber, body.expectedVersion, order);
  }

  // ─ State-machine validation ────────────────────────────────────────────
  if (!canTransition(order.status, to, order.paymentMethod)) {
    const allowed = allowedTargets(order.status, order.paymentMethod);
    throw new ApiError({
      type: "/problems/invalid-status-transition",
      title: "Invalid Status Transition",
      status: 409,
      detail:
        `Order ${orderNumber} is "${order.status}" (${order.paymentMethod}); ` +
        (allowed.length > 0
          ? `it can only move to: ${allowed.join(", ")}.`
          : "it is in a terminal status and cannot change."),
    });
  }

  // ─ Companion-field validation ──────────────────────────────────────────
  const required = requiredFieldsForTarget(to);
  const missing = required.filter((f) => body[f] === undefined);
  if (missing.length > 0) {
    throw badRequest(
      `Missing required field(s) for status "${to}".`,
      missing.map((f) => ({ path: f, message: `Required when status is "${to}"` })),
    );
  }
  // Reject companion fields that do not belong to the requested target —
  // a courierCompany on a cancellation is a client bug worth surfacing.
  const allowedFields = new Set<string>([
    ...required,
    ...(to === "cancelled" ? ["cancelledReason"] : []),
  ]);
  const stray = (
    ["courierCompany", "trackingNumber", "pickupDeadline", "cancelledReason"] as const
  ).filter((f) => body[f] !== undefined && !allowedFields.has(f));
  if (stray.length > 0) {
    throw badRequest(
      `Field(s) not applicable to status "${to}".`,
      stray.map((f) => ({ path: f, message: `Not applicable to "${to}"` })),
    );
  }

  let pickupDeadline: Date | null = null;
  if (to === "ready_for_pickup") {
    pickupDeadline = new Date(body.pickupDeadline!);
    if (pickupDeadline.getTime() <= Date.now()) {
      throw badRequest("pickupDeadline must be in the future.", [
        { path: "pickupDeadline", message: "Must be in the future" },
      ]);
    }
  }

  // ─ Atomic transition + audit entry ─────────────────────────────────────
  // The UPDATE pins BOTH the version the admin saw and the status the
  // transition was validated against; any concurrent change makes it a no-op
  // (0 rows) → version conflict. History INSERT shares the transaction so the
  // audit trail can never disagree with the row.
  const changedAt = new Date();
  const updatedRow = await db.transaction(async (tx) => {
    const updated = await tx
      .update(schema.orders)
      .set({
        status: to,
        version: order.version + 1,
        ...(to === "shipped"
          ? {
              courierCompany: body.courierCompany!,
              trackingNumber: body.trackingNumber!,
            }
          : {}),
        ...(to === "ready_for_pickup" ? { pickupDeadline } : {}),
        ...(to === "cancelled"
          ? { cancelledReason: body.cancelledReason ?? null }
          : {}),
        ...(to === "accepted" ? { acceptedAt: changedAt } : {}),
      })
      .where(
        and(
          eq(schema.orders.id, order.id),
          eq(schema.orders.version, body.expectedVersion),
          eq(schema.orders.status, order.status),
        ),
      )
      .returning();
    const row = updated[0];
    if (!row) return null;
    await tx.insert(schema.orderStatusHistory).values({
      orderId: order.id,
      status: to,
      changedByUserId: admin.id,
      note: body.note ?? null,
    });
    return row;
  });

  if (!updatedRow) {
    // A concurrent transition won the race between our read and our write
    // (the pre-check above already caught plainly-stale screens).
    const [fresh] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, order.id))
      .limit(1);
    throw orderVersionConflict(orderNumber, body.expectedVersion, fresh ?? null);
  }

  log.info(
    {
      orderNumber,
      from: order.status,
      to,
      adminId: admin.id,
      version: updatedRow.version,
    },
    "admin_order_status_changed",
  );

  // ─ Customer notification (best-effort, never blocks the transition) ────
  if (isCustomerNotifiableStatus(to)) {
    // Guest orders (no account) get the durable /track capability link so the
    // status email lands somewhere they can actually open; account orders fall
    // back to the helper's default /account/orders page.
    const guestTrackUrl =
      updatedRow.customerId === null && updatedRow.guestTrackToken
        ? `${parseEnv().PUBLIC_APP_BASE_URL}/track/${updatedRow.guestTrackToken}`
        : undefined;
    await sendOrderStatusUpdateEmail({
      to: updatedRow.customerEmail,
      customerName: updatedRow.customerName,
      orderNumber: updatedRow.orderNumber,
      status: to,
      changedAt,
      courierCompany: to === "shipped" ? updatedRow.courierCompany : null,
      trackingNumber: to === "shipped" ? updatedRow.trackingNumber : null,
      pickupDeadline: to === "ready_for_pickup" ? updatedRow.pickupDeadline : null,
      cancelledReason: to === "cancelled" ? updatedRow.cancelledReason : null,
      orderUrl: guestTrackUrl,
      logger: log,
    });
  }

  return c.json(await loadAdminOrderDetail(db, updatedRow), 200);
});

/** Allowed transition map re-exported for consumers (UI mirrors, tests). */
export type { OrderStatus, TransitionTarget };
