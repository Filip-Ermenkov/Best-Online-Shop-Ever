import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { schema } from "@shop/db";
import { and, desc, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Logger } from "pino";
import {
  AccountAlreadyDeletedError,
  UserRowMissingError,
  executeAccountDeletion,
  findActiveOrdersForUser,
  sendAccountDeletedEmail,
} from "../../lib/account-deletion.js";
import { getDb } from "../../lib/db.js";
import { ApiError, ProblemSchema, badRequest, notFound } from "../../lib/errors.js";
import { logger as baseLogger } from "../../lib/logger.js";
import { validationHook } from "../../lib/validation-hook.js";
import { requireAdmin } from "../../middleware/admin.js";
import type { AuthVariables } from "../../middleware/auth.js";

/**
 * Admin account management — the real /admin/customers screen
 * (docs/README.md §"Управление на акаунти" + §11 "Отстъпки"). The sixth admin
 * CRUD slice, after orders / categories / products / banners / settings.
 *
 * Surface (all behind `requireAdmin` — non-admins get the uniform 404):
 *
 *   GET    /admin/customers               offset-paginated list + search + filters
 *   GET    /admin/customers/:id           full account detail (+ discount + orders)
 *   PUT    /admin/customers/:id/discount  set the per-account percentage discount
 *   DELETE /admin/customers/:id/discount  clear the discount
 *   DELETE /admin/customers/:id           delete the account (GDPR Art. 17)
 *
 * Design notes (researched against 2026 practice — see ARCHITECTURE §13):
 *
 *   - **Activates the dormant `discounts` table's WRITE side.** Checkout has read
 *     `discounts.percent` since the first orders slice (a per-account percentage
 *     applied to the whole basket, integer-cent floor — routes/orders.ts), but no
 *     route could ever WRITE a discount: the only way to grant a B2B customer
 *     their contracted rate was a raw `INSERT INTO discounts` in psql. This slice
 *     is that table's first writer — the same "retire the manual SQL" driver
 *     behind every prior admin slice. Spec §11: a discount is personalised (one
 *     per account), expressed in percent, applied to all products; guests get none.
 *
 *   - **Per-account single discount, percent only.** The `discounts` PK is
 *     `user_id`, so a customer has at most one active discount — exactly the
 *     spec's „един акаунт може да има само една активна отстъпка". Product-level
 *     discounts (a price cut visible to everyone) are a documented future door
 *     (spec §11 „Бъдещо развитие"; ARCHITECTURE §16) and deliberately NOT built
 *     here. This is the standard B2B account-level / customer-group pricing shape.
 *
 *   - **Discount governance / audit trail.** Every set or clear appends an
 *     `admin_audit_log` row (GDPR Art. 30) with the before/after percent, and the
 *     `discounts` row itself records WHO applied it (`applied_by_user_id`) and
 *     WHEN (`applied_at`) — surfaced on the detail view. 2026 B2B pricing practice
 *     treats the discount book as a governed, auditable artefact, not a free-text
 *     field.
 *
 *   - **Optimistic locking WITHOUT a `version` column** — same discipline as the
 *     banners/products/categories slices, but the lock token here is the
 *     `discounts.applied_at` timestamp (the row has no `updated_at`). SET echoes
 *     back the `expectedAppliedAt` the screen rendered from; the handler locks the
 *     customer row `FOR UPDATE`, re-reads the discount row, and compares at
 *     millisecond precision before writing — so two admins can't stomp each other.
 *     A fresh grant sends `expectedAppliedAt = null` and conflicts if a discount
 *     appeared meanwhile. Because `applied_at` defaults to the DB `now()` (µs
 *     precision) we set it explicitly to a JS `Date` (ms) on every write, so the
 *     token round-trips cleanly (the same µs-vs-ms pitfall the other slices dodge).
 *
 *   - **Admin PII access is logged, not just writes.** 2026 insider-risk / GDPR
 *     data-minimisation guidance is to record admin *reads* of customer PII, not
 *     only state changes. The detail view (which exposes a customer's name, phone,
 *     company data and order history) emits a structured `admin_customer_viewed`
 *     Pino event (adminId + customerId, no PII in the log line). It does NOT write
 *     to `admin_audit_log` — that table is documented as the record of
 *     state-CHANGING actions; a read is not one. Secrets (password hash, MFA
 *     secret, tokens, raw login telemetry) are never selected into the DTO at all.
 *
 *   - **Account deletion reuses the GDPR Art. 17 erasure library.** `DELETE
 *     /:id` runs the spec §10 active-order guard (`findActiveOrdersForUser` →
 *     422 with the blocking order numbers, identical to the customer's own
 *     `DELETE /auth/me`) and then the SAME `executeAccountDeletion` transaction
 *     the self-service path uses (pseudonymise the users row + orders PII under
 *     the Bulgarian 10-year accounting-retention exemption, hard-delete profile /
 *     cart / addresses / discount / tokens). The operator is acting on a data
 *     subject's erasure request received out-of-band, or removing a defunct
 *     account; the admin's AAL2 authority stands in for the customer's password
 *     re-auth. Best-effort `account-deleted` notice to the original address.
 */

type AdminCustomersVariables = AuthVariables & {
  logger: Logger;
  requestId: string;
};

export const adminCustomersRoutes = new OpenAPIHono<{
  Variables: AdminCustomersVariables;
}>({
  defaultHook: validationHook,
});

// currentUser runs in app.ts (resolves the cookie); requireAdmin turns the whole
// surface into a flat 404 for non-admins — uniform with the rest of the admin API.
adminCustomersRoutes.use("*", requireAdmin);

const PAGE_SIZE = 25;

// ─── DTOs ────────────────────────────────────────────────────────────────────

const AccountTypeSchema = z
  .enum(["personal", "corporate"])
  .openapi("AdminCustomerAccountType");

const AdminCustomerSummarySchema = z
  .object({
    id: z.string().uuid(),
    email: z.string(),
    accountType: AccountTypeSchema,
    /** Personal full name, or the company name for a corporate account. */
    displayName: z.string(),
    emailVerified: z.boolean(),
    /** The active percentage discount, or null when none is set. */
    discountPercent: z.number().nullable(),
    orderCount: z.number().int(),
    createdAt: z.string(),
  })
  .openapi("AdminCustomerSummary");

export type AdminCustomerSummary = z.infer<typeof AdminCustomerSummarySchema>;

const AdminCustomerListSchema = z
  .object({
    items: z.array(AdminCustomerSummarySchema),
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
    totalPages: z.number().int(),
  })
  .openapi("AdminCustomerList");

export type AdminCustomerList = z.infer<typeof AdminCustomerListSchema>;

const AdminCustomerDiscountSchema = z
  .object({
    percent: z.number(),
    appliedAt: z.string(),
    /** Email of the admin who applied it (null if that admin's row is gone). */
    appliedByEmail: z.string().nullable(),
  })
  .openapi("AdminCustomerDiscount");

export type AdminCustomerDiscount = z.infer<typeof AdminCustomerDiscountSchema>;

const PersonalProfileSchema = z
  .object({ fullName: z.string(), phone: z.string() })
  .openapi("AdminCustomerPersonalProfile");

const CorporateProfileSchema = z
  .object({
    companyName: z.string(),
    eik: z.string(),
    vatNumber: z.string().nullable(),
    registeredAddress: z.string(),
    mol: z.string(),
    contactName: z.string(),
    contactPhone: z.string(),
  })
  .openapi("AdminCustomerCorporateProfile");

const AdminCustomerOrderSchema = z
  .object({
    orderNumber: z.string(),
    status: z.string(),
    totalCents: z.number().int(),
    itemCount: z.number().int(),
    createdAt: z.string(),
  })
  .openapi("AdminCustomerOrder");

const AdminCustomerDetailSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string(),
    accountType: AccountTypeSchema,
    emailVerified: z.boolean(),
    createdAt: z.string(),
    personal: PersonalProfileSchema.nullable(),
    corporate: CorporateProfileSchema.nullable(),
    discount: AdminCustomerDiscountSchema.nullable(),
    /** Newest-first, capped; `orderCount` is the true total. */
    orders: z.array(AdminCustomerOrderSchema),
    orderCount: z.number().int(),
  })
  .openapi("AdminCustomerDetail");

export type AdminCustomerDetail = z.infer<typeof AdminCustomerDetailSchema>;

// ─── Request schemas ─────────────────────────────────────────────────────────

const ListQuerySchema = z.object({
  page: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .openapi({ param: { name: "page", in: "query" } }),
  q: z
    .string()
    .trim()
    .max(200)
    .optional()
    .openapi({ param: { name: "q", in: "query" } }),
  accountType: z
    .enum(["personal", "corporate", "all"])
    .optional()
    .openapi({ param: { name: "accountType", in: "query" } }),
  hasDiscount: z
    .enum(["true", "false"])
    .optional()
    .openapi({ param: { name: "hasDiscount", in: "query" } }),
});

const percentField = z
  .number()
  .positive("Discount must be greater than 0 (use DELETE to remove one).")
  .max(100, "Discount cannot exceed 100%.")
  .refine(
    (v) => Math.abs(Math.round(v * 100) - v * 100) < 1e-6,
    "At most two decimal places.",
  );

const SetDiscountRequestSchema = z
  .object({
    percent: percentField,
    /**
     * The `applied_at` the screen last saw (optimistic lock). Omit / null when
     * the screen showed no discount — a conflict then means one appeared since.
     */
    expectedAppliedAt: z.string().nullable().optional(),
  })
  .strict()
  .openapi("AdminCustomerSetDiscountRequest");

const DeleteRequestSchema = z
  .object({
    /** The spec's „Разбирам последствията" confirmation — must be explicitly true. */
    confirmConsequences: z.literal(true),
  })
  .strict()
  .openapi("AdminCustomerDeleteRequest");

const ParamId = z.object({
  id: z.string().uuid().openapi({ param: { name: "id", in: "path" } }),
});

// ─── Problem builders ─────────────────────────────────────────────────────────

function customerNotFound(id: string): ApiError {
  return notFound(`No customer with id ${id}.`, "/problems/customer-not-found");
}

function discountConflict(id: string): ApiError {
  return new ApiError({
    type: "/problems/customer-discount-conflict",
    title: "Discount Was Updated Concurrently",
    status: 409,
    detail: `The discount for customer ${id} changed since your screen loaded. Reload and retry.`,
  });
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

function clientUserAgent(c: {
  req: { header: (n: string) => string | undefined };
}): string | null {
  return c.req.header("user-agent") ?? null;
}

/** Load the active discount for a customer with the applying admin's email. */
async function loadDiscount(
  db: ReturnType<typeof getDb>,
  userId: string,
): Promise<AdminCustomerDiscount | null> {
  const appliedBy = alias(schema.users, "applied_by_user");
  const [row] = await db
    .select({
      percent: schema.discounts.percent,
      appliedAt: schema.discounts.appliedAt,
      appliedByEmail: appliedBy.email,
    })
    .from(schema.discounts)
    .leftJoin(appliedBy, eq(appliedBy.id, schema.discounts.appliedByUserId))
    .where(eq(schema.discounts.userId, userId))
    .limit(1);
  if (!row) return null;
  return {
    percent: Number(row.percent),
    appliedAt: row.appliedAt.toISOString(),
    appliedByEmail: row.appliedByEmail ?? null,
  };
}

// ─── GET /admin/customers ─────────────────────────────────────────────────────

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["admin-customers"],
  summary: "Registered customer accounts (paginated, searchable, filterable)",
  request: { query: ListQuerySchema },
  responses: {
    200: {
      description: "A page of customer accounts.",
      content: { "application/json": { schema: AdminCustomerListSchema } },
    },
    404: {
      description: "No admin session (uniform with the rest of the surface).",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminCustomersRoutes.openapi(listRoute, async (c) => {
  const db = getDb();
  const { page: pageRaw, q, accountType, hasDiscount } = c.req.valid("query");
  const page = pageRaw && pageRaw > 0 ? pageRaw : 1;
  const offset = (page - 1) * PAGE_SIZE;

  // Only real customers, never admins, never pseudonymised (deleted) rows.
  const conds: SQL[] = [
    eq(schema.users.role, "customer"),
    isNull(schema.users.deletedAt),
  ];
  if (accountType === "personal" || accountType === "corporate") {
    conds.push(eq(schema.users.accountType, accountType));
  }
  if (hasDiscount === "true") {
    conds.push(sql`${schema.discounts.userId} is not null`);
  } else if (hasDiscount === "false") {
    conds.push(sql`${schema.discounts.userId} is null`);
  }
  if (q) {
    const like = `%${q.toLowerCase()}%`;
    const search = or(
      ilike(schema.users.email, like),
      ilike(schema.customerProfiles.fullName, like),
      ilike(schema.corporateProfiles.companyName, like),
      ilike(schema.corporateProfiles.contactName, like),
    );
    if (search) conds.push(search);
  }
  const whereClause = and(...conds);

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.users)
    .leftJoin(
      schema.customerProfiles,
      eq(schema.customerProfiles.userId, schema.users.id),
    )
    .leftJoin(
      schema.corporateProfiles,
      eq(schema.corporateProfiles.userId, schema.users.id),
    )
    .leftJoin(schema.discounts, eq(schema.discounts.userId, schema.users.id))
    .where(whereClause);
  const total = countRow?.count ?? 0;

  const rows = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      accountType: schema.users.accountType,
      emailVerifiedAt: schema.users.emailVerifiedAt,
      createdAt: schema.users.createdAt,
      fullName: schema.customerProfiles.fullName,
      companyName: schema.corporateProfiles.companyName,
      discountPercent: schema.discounts.percent,
      orderCount: sql<number>`(select count(*)::int from ${schema.orders} where ${schema.orders.customerId} = ${schema.users.id})`,
    })
    .from(schema.users)
    .leftJoin(
      schema.customerProfiles,
      eq(schema.customerProfiles.userId, schema.users.id),
    )
    .leftJoin(
      schema.corporateProfiles,
      eq(schema.corporateProfiles.userId, schema.users.id),
    )
    .leftJoin(schema.discounts, eq(schema.discounts.userId, schema.users.id))
    .where(whereClause)
    .orderBy(desc(schema.users.createdAt))
    .limit(PAGE_SIZE)
    .offset(offset);

  const items: AdminCustomerSummary[] = rows.map((r) => ({
    id: r.id,
    email: r.email,
    accountType: (r.accountType ?? "personal") as "personal" | "corporate",
    displayName: r.fullName ?? r.companyName ?? r.email,
    emailVerified: r.emailVerifiedAt != null,
    discountPercent: r.discountPercent != null ? Number(r.discountPercent) : null,
    orderCount: Number(r.orderCount ?? 0),
    createdAt: r.createdAt.toISOString(),
  }));

  return c.json(
    {
      items,
      page,
      pageSize: PAGE_SIZE,
      total,
      totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    },
    200,
  );
});

// ─── GET /admin/customers/:id ─────────────────────────────────────────────────

const detailRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["admin-customers"],
  summary: "Full customer detail — profile, discount, and order history",
  request: { params: ParamId },
  responses: {
    200: {
      description: "The customer detail.",
      content: { "application/json": { schema: AdminCustomerDetailSchema } },
    },
    404: {
      description: "`/problems/customer-not-found` (or no admin session).",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminCustomersRoutes.openapi(detailRoute, async (c) => {
  const db = getDb();
  const admin = c.get("user")!;
  const log = c.get("logger") ?? baseLogger;
  const { id } = c.req.valid("param");

  const [user] = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      role: schema.users.role,
      accountType: schema.users.accountType,
      emailVerifiedAt: schema.users.emailVerifiedAt,
      createdAt: schema.users.createdAt,
      deletedAt: schema.users.deletedAt,
    })
    .from(schema.users)
    .where(eq(schema.users.id, id))
    .limit(1);
  if (!user || user.role !== "customer" || user.deletedAt) {
    throw customerNotFound(id);
  }

  let personal: { fullName: string; phone: string } | null = null;
  let corporate: z.infer<typeof CorporateProfileSchema> | null = null;
  if (user.accountType === "personal") {
    const [row] = await db
      .select({
        fullName: schema.customerProfiles.fullName,
        phone: schema.customerProfiles.phone,
      })
      .from(schema.customerProfiles)
      .where(eq(schema.customerProfiles.userId, id))
      .limit(1);
    personal = row ?? null;
  } else if (user.accountType === "corporate") {
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
      .where(eq(schema.corporateProfiles.userId, id))
      .limit(1);
    corporate = row ?? null;
  }

  const discount = await loadDiscount(db, id);

  const orderRows = await db
    .select({
      orderNumber: schema.orders.orderNumber,
      status: schema.orders.status,
      totalCents: schema.orders.totalCents,
      createdAt: schema.orders.createdAt,
      itemCount: sql<number>`(select count(*)::int from ${schema.orderItems} where ${schema.orderItems.orderId} = ${schema.orders.id})`,
    })
    .from(schema.orders)
    .where(eq(schema.orders.customerId, id))
    .orderBy(desc(schema.orders.createdAt))
    .limit(100);

  const [orderCountRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.orders)
    .where(eq(schema.orders.customerId, id));

  // 2026 insider-risk / GDPR data-minimisation: log admin READS of customer PII,
  // not only state changes. No PII in the log line — just the actor + subject id.
  log.info(
    { event: "admin_customer_viewed", adminId: admin.id, customerId: id },
    "admin_customer_viewed",
  );

  return c.json(
    {
      id: user.id,
      email: user.email,
      accountType: (user.accountType ?? "personal") as "personal" | "corporate",
      emailVerified: user.emailVerifiedAt != null,
      createdAt: user.createdAt.toISOString(),
      personal,
      corporate,
      discount,
      orders: orderRows.map((o) => ({
        orderNumber: o.orderNumber,
        status: o.status,
        totalCents: Number(o.totalCents),
        itemCount: Number(o.itemCount ?? 0),
        createdAt: o.createdAt.toISOString(),
      })),
      orderCount: orderCountRow?.count ?? 0,
    },
    200,
  );
});

// ─── PUT /admin/customers/:id/discount ────────────────────────────────────────

const setDiscountRoute = createRoute({
  method: "put",
  path: "/{id}/discount",
  tags: ["admin-customers"],
  summary: "Set the per-account percentage discount",
  request: {
    params: ParamId,
    body: {
      content: { "application/json": { schema: SetDiscountRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "The applied discount.",
      content: { "application/json": { schema: AdminCustomerDiscountSchema } },
    },
    400: {
      description: "Validation error (percent out of range / too precise).",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    404: {
      description: "`/problems/customer-not-found`.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    409: {
      description: "`/problems/customer-discount-conflict` (stale screen).",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminCustomersRoutes.openapi(setDiscountRoute, async (c) => {
  const db = getDb();
  const admin = c.get("user")!;
  const log = c.get("logger") ?? baseLogger;
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  let expectedMs: number | null = null;
  if (body.expectedAppliedAt != null) {
    expectedMs = Date.parse(body.expectedAppliedAt);
    if (Number.isNaN(expectedMs)) {
      throw badRequest("expectedAppliedAt is not a valid timestamp.", [
        { path: "expectedAppliedAt", message: "Must be an ISO-8601 timestamp." },
      ]);
    }
  }

  const percentStr = body.percent.toFixed(2);
  const appliedAt = new Date();

  const outcome = await db.transaction(async (tx) => {
    // Lock the customer row: the critical section for concurrent discount writes.
    const [u] = await tx
      .select({
        role: schema.users.role,
        deletedAt: schema.users.deletedAt,
      })
      .from(schema.users)
      .where(eq(schema.users.id, id))
      .limit(1)
      .for("update");
    if (!u || u.role !== "customer" || u.deletedAt) {
      return { kind: "not_found" as const };
    }

    const [existing] = await tx
      .select({
        percent: schema.discounts.percent,
        appliedAt: schema.discounts.appliedAt,
      })
      .from(schema.discounts)
      .where(eq(schema.discounts.userId, id))
      .limit(1)
      .for("update");

    // Optimistic lock: the screen's view of the discount must still hold.
    if (expectedMs == null) {
      if (existing) return { kind: "conflict" as const };
    } else {
      if (!existing || existing.appliedAt.getTime() !== expectedMs) {
        return { kind: "conflict" as const };
      }
    }

    await tx
      .insert(schema.discounts)
      .values({
        userId: id,
        percent: percentStr,
        appliedByUserId: admin.id,
        appliedAt,
      })
      .onConflictDoUpdate({
        target: schema.discounts.userId,
        set: { percent: percentStr, appliedByUserId: admin.id, appliedAt },
      });

    await tx.insert(schema.adminAuditLog).values({
      actorUserId: admin.id,
      action: "customer.discount_set",
      entityTable: "discounts",
      entityId: id,
      changes: {
        before: existing ? { percent: Number(existing.percent) } : null,
        after: { percent: body.percent },
      },
      userAgent: clientUserAgent(c),
    });
    return { kind: "ok" as const };
  });

  if (outcome.kind === "not_found") throw customerNotFound(id);
  if (outcome.kind === "conflict") throw discountConflict(id);

  log.info(
    { customerId: id, adminId: admin.id, percent: body.percent },
    "customer_discount_set",
  );
  return c.json(
    {
      percent: body.percent,
      appliedAt: appliedAt.toISOString(),
      appliedByEmail: admin.email,
    },
    200,
  );
});

// ─── DELETE /admin/customers/:id/discount ─────────────────────────────────────

const clearDiscountRoute = createRoute({
  method: "delete",
  path: "/{id}/discount",
  tags: ["admin-customers"],
  summary: "Clear the per-account discount (idempotent)",
  request: { params: ParamId },
  responses: {
    200: {
      description: "Whether a discount was removed (`false` = there was none).",
      content: {
        "application/json": {
          schema: z
            .object({ cleared: z.boolean() })
            .openapi("AdminCustomerClearDiscountResult"),
        },
      },
    },
    404: {
      description: "`/problems/customer-not-found`.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminCustomersRoutes.openapi(clearDiscountRoute, async (c) => {
  const db = getDb();
  const admin = c.get("user")!;
  const log = c.get("logger") ?? baseLogger;
  const { id } = c.req.valid("param");

  const outcome = await db.transaction(async (tx) => {
    const [u] = await tx
      .select({
        role: schema.users.role,
        deletedAt: schema.users.deletedAt,
      })
      .from(schema.users)
      .where(eq(schema.users.id, id))
      .limit(1)
      .for("update");
    if (!u || u.role !== "customer" || u.deletedAt) {
      return { kind: "not_found" as const };
    }

    const [existing] = await tx
      .select({ percent: schema.discounts.percent })
      .from(schema.discounts)
      .where(eq(schema.discounts.userId, id))
      .limit(1);
    if (!existing) return { kind: "noop" as const };

    await tx.delete(schema.discounts).where(eq(schema.discounts.userId, id));

    await tx.insert(schema.adminAuditLog).values({
      actorUserId: admin.id,
      action: "customer.discount_cleared",
      entityTable: "discounts",
      entityId: id,
      changes: { before: { percent: Number(existing.percent) }, after: null },
      userAgent: clientUserAgent(c),
    });
    return { kind: "cleared" as const };
  });

  if (outcome.kind === "not_found") throw customerNotFound(id);
  if (outcome.kind === "cleared") {
    log.info({ customerId: id, adminId: admin.id }, "customer_discount_cleared");
  }
  return c.json({ cleared: outcome.kind === "cleared" }, 200);
});

// ─── DELETE /admin/customers/:id ──────────────────────────────────────────────

const deleteRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["admin-customers"],
  summary: "Delete a customer account (GDPR Art. 17; blocked by active orders)",
  request: {
    params: ParamId,
    body: { content: { "application/json": { schema: DeleteRequestSchema } } },
  },
  responses: {
    200: {
      description: "Deletion confirmation.",
      content: {
        "application/json": {
          schema: z
            .object({ deleted: z.boolean() })
            .openapi("AdminCustomerDeleteResult"),
        },
      },
    },
    404: {
      description: "`/problems/customer-not-found`.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    422: {
      description:
        "`/problems/active-orders-block-deletion` — the account has orders still in flight; the blocking order numbers are in `errors`.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminCustomersRoutes.openapi(deleteRoute, async (c) => {
  const db = getDb();
  const admin = c.get("user")!;
  const log = c.get("logger") ?? baseLogger;
  const { id } = c.req.valid("param");

  const [target] = await db
    .select({ role: schema.users.role, deletedAt: schema.users.deletedAt })
    .from(schema.users)
    .where(eq(schema.users.id, id))
    .limit(1);
  if (!target || target.role !== "customer" || target.deletedAt) {
    throw customerNotFound(id);
  }

  // Active-order guard (spec §10) — refuse while a contract is still live.
  // Mirrors the customer's own DELETE /auth/me 422, same problem type + shape.
  const blocking = await findActiveOrdersForUser(id);
  if (blocking.orderNumbers.length > 0) {
    throw new ApiError({
      type: "/problems/active-orders-block-deletion",
      title: "Unprocessable Entity",
      status: 422,
      detail:
        "This account has orders still being processed. They must reach a " +
        "final status (accepted / returned / cancelled) before it can be deleted.",
      errors: blocking.orderNumbers.map((orderNumber) => ({
        path: orderNumber,
        message: `Order ${orderNumber} is still in an active state and must be completed first.`,
      })),
    });
  }

  let result: Awaited<ReturnType<typeof executeAccountDeletion>>;
  try {
    result = await executeAccountDeletion({ userId: id });
  } catch (err) {
    // Raced with another delete (self-service or a second admin tab) — collapse
    // to the uniform not-found rather than a 500.
    if (
      err instanceof AccountAlreadyDeletedError ||
      err instanceof UserRowMissingError
    ) {
      throw customerNotFound(id);
    }
    throw err;
  }

  // Audit AFTER the erasure transaction (it owns its own txn). The pseudonymised
  // users row still carries the id, so the Art. 30 trail resolves.
  await db.insert(schema.adminAuditLog).values({
    actorUserId: admin.id,
    action: "customer.delete",
    entityTable: "users",
    entityId: id,
    changes: { after: { deletedAt: result.deletedAt.toISOString() } },
    userAgent: clientUserAgent(c),
  });

  // Best-effort post-deletion notice to the original address (never blocks).
  await sendAccountDeletedEmail({
    to: result.originalEmail,
    fullName: result.originalFullName,
    deletedAt: result.deletedAt,
    logger: log,
  });

  log.info({ customerId: id, adminId: admin.id }, "admin_customer_deleted");
  return c.json({ deleted: true }, 200);
});
