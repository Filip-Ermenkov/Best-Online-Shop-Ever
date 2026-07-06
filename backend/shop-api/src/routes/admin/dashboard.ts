import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { schema } from "@shop/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { getDb } from "../../lib/db.js";
import {
  averageOrderValueCents,
  buildDaySeries,
  sofiaDate,
  type DaySeriesRow,
} from "../../lib/dashboard-metrics.js";
import { ProblemSchema } from "../../lib/errors.js";
import { logger as baseLogger } from "../../lib/logger.js";
import { validationHook } from "../../lib/validation-hook.js";
import { requireAdmin } from "../../middleware/admin.js";
import type { AuthVariables } from "../../middleware/auth.js";

/**
 * Admin dashboard — the real `/admin` landing screen (docs/README.md
 * §"Табло"). Read-only operational overview; un-mocks the last high-traffic
 * admin page, which until now rendered fabricated numbers off
 * `frontend/src/lib/mock-data/*` on every login.
 *
 * Surface (behind `requireAdmin` — non-admins get the uniform 404):
 *
 *   GET /admin/dashboard   the whole summary in one payload
 *
 * Design notes (researched against 2026 practice — see ARCHITECTURE §13):
 *
 *   - **On-the-fly aggregation, not a materialised view.** The 2026 guidance is
 *     to compute dashboard aggregates at read time while the queries are cheap
 *     and the operator wants real-time numbers, and to promote to a scheduled
 *     materialised view / summary table only once the query is expensive AND
 *     staleness is tolerable. At this shop's tier (0–500 orders/mo) every query
 *     here is an indexed single-digit-ms scan over `orders` / `products` /
 *     `users`, and an operator who just accepted an order expects the count to
 *     move immediately — so read-time aggregation is correct now. The migration
 *     trigger is documented (Tier 3+ / material dashboard latency), mirroring the
 *     §16 search-infrastructure threshold.
 *
 *   - **Metrics are honest about what this shop can measure.** 2026 KPI guides
 *     lead with conversion rate, traffic, LTV and CAC — all of which need
 *     web-analytics this cash-on-delivery / pay-at-store shop deliberately does
 *     not collect. Rather than fabricate them, the dashboard reports only what
 *     the database actually knows: realised sales (orders + revenue), average
 *     order value (a "Big Five" KPI = revenue ÷ orders), new registrations, the
 *     operational action queue, and a 14-day trend.
 *
 *   - **Realised-sales definition, kept coherent.** The sales trio (orders,
 *     revenue, AOV — for the month, for today, and per day on the trend) counts
 *     only orders whose status is NOT `cancelled` and NOT `returned`: a cancelled
 *     order is not a sale, and a returned one was reversed. Because revenue and
 *     the order count are computed over the SAME set, AOV = revenue ÷ orders is a
 *     true per-order average, not a ratio of two different populations. `Recent
 *     orders` deliberately shows every status (it is an activity feed, not a
 *     sales figure).
 *
 *   - **Europe/Sofia period bounds.** "This month" and "today" are Sofia calendar
 *     boundaries, not UTC — a 01:00 EET order belongs to the Bulgarian day it was
 *     placed on. The bounds are built in SQL (`date_trunc(... AT TIME ZONE
 *     'Europe/Sofia') AT TIME ZONE 'Europe/Sofia'`) so they land as `timestamptz`
 *     instants the planner can range-scan on `orders_created_at_idx`, and they
 *     are DST-correct. Same idiom the admin-orders date filter and the order-
 *     number sequence already use.
 *
 *   - **Admin PII reads are logged.** The recent-orders feed surfaces customer
 *     names, so — consistent with the account-management slice (§13.x item 49) —
 *     viewing the dashboard emits a structured `admin_dashboard_viewed` Pino
 *     event (actor id only, no PII in the line). It is a read, so it does NOT
 *     write to `admin_audit_log` (that table records state-CHANGING actions).
 */

type AdminDashboardVariables = AuthVariables & {
  logger: Logger;
  requestId: string;
};

export const adminDashboardRoutes = new OpenAPIHono<{
  Variables: AdminDashboardVariables;
}>({
  defaultHook: validationHook,
});

// currentUser runs in app.ts; requireAdmin collapses the surface to a flat 404
// for non-admins — uniform with the rest of the admin API.
adminDashboardRoutes.use("*", requireAdmin);

const TREND_DAYS = 14;
const RECENT_ORDERS = 8;
const LOW_STOCK_ITEMS = 8;

// ─── DTOs ────────────────────────────────────────────────────────────────────

const SalesPeriodSchema = z
  .object({
    orders: z.number().int(),
    revenueCents: z.number().int(),
  })
  .openapi("DashboardSalesPeriod");

const MonthSalesSchema = z
  .object({
    orders: z.number().int(),
    revenueCents: z.number().int(),
    averageOrderValueCents: z.number().int(),
  })
  .openapi("DashboardMonthSales");

const NewCustomersSchema = z
  .object({ today: z.number().int(), month: z.number().int() })
  .openapi("DashboardNewCustomers");

const ActionQueueSchema = z
  .object({
    /** Orders in `processing` — freshly placed, awaiting the admin's acceptance. */
    newOrders: z.number().int(),
    /** `ready_for_pickup` orders whose pickup deadline has passed (spec §7). */
    expiredPickups: z.number().int(),
    /** Active products currently marked out of stock. */
    outOfStockProducts: z.number().int(),
  })
  .openapi("DashboardActionQueue");

const CatalogSnapshotSchema = z
  .object({
    activeProducts: z.number().int(),
    activeCategories: z.number().int(),
    totalCustomers: z.number().int(),
  })
  .openapi("DashboardCatalogSnapshot");

const LowStockItemSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    code: z.string(),
  })
  .openapi("DashboardLowStockItem");

const RecentOrderSchema = z
  .object({
    orderNumber: z.string(),
    status: z.string(),
    customerName: z.string(),
    totalCents: z.number().int(),
    createdAt: z.string(),
  })
  .openapi("DashboardRecentOrder");

const DayPointSchema = z
  .object({
    date: z.string(),
    orders: z.number().int(),
    revenueCents: z.number().int(),
  })
  .openapi("DashboardDayPoint");

const DashboardSummarySchema = z
  .object({
    generatedAt: z.string(),
    timezone: z.string(),
    month: MonthSalesSchema,
    today: SalesPeriodSchema,
    newCustomers: NewCustomersSchema,
    actionQueue: ActionQueueSchema,
    catalog: CatalogSnapshotSchema,
    /** Out-of-stock products, most-recently-changed first (capped). */
    lowStock: z.array(LowStockItemSchema),
    /** Newest-first activity feed (every status; capped). */
    recentOrders: z.array(RecentOrderSchema),
    /** Oldest → newest realised-sales trend, always exactly `TREND_DAYS` points. */
    dailySeries: z.array(DayPointSchema),
  })
  .openapi("DashboardSummary");

export type DashboardSummary = z.infer<typeof DashboardSummarySchema>;

// ─── Driver-portable raw-row readers (neon-http returns rows[]; node-pg {rows}) ─

function pickFirstRow<T>(result: unknown): T | null {
  if (Array.isArray(result)) return (result[0] as T | undefined) ?? null;
  const r = result as { rows?: unknown[] } | null | undefined;
  if (r && Array.isArray(r.rows)) return (r.rows[0] as T | undefined) ?? null;
  return null;
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const r = result as { rows?: unknown[] } | null | undefined;
  return (r?.rows as T[] | undefined) ?? [];
}

// ─── GET /admin/dashboard ─────────────────────────────────────────────────────

const summaryRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["admin-dashboard"],
  summary: "Operational overview — sales, action queue, catalog, and a 14-day trend",
  responses: {
    200: {
      description: "The dashboard summary.",
      content: { "application/json": { schema: DashboardSummarySchema } },
    },
    404: {
      description: "No admin session (uniform with the rest of the surface).",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminDashboardRoutes.openapi(summaryRoute, async (c) => {
  const db = getDb();
  const admin = c.get("user")!;
  const log = c.get("logger") ?? baseLogger;

  const o = schema.orders;
  const p = schema.products;
  const cat = schema.categories;
  const u = schema.users;

  // Europe/Sofia period boundaries as `timestamptz` instants (DST-correct):
  // take the Sofia-local wall-clock start-of-period, then reinterpret it in
  // Sofia to get the UTC instant the `created_at` range scan compares against.
  const monthStart = sql`(date_trunc('month', now() AT TIME ZONE 'Europe/Sofia')) AT TIME ZONE 'Europe/Sofia'`;
  const todayStart = sql`((now() AT TIME ZONE 'Europe/Sofia')::date) AT TIME ZONE 'Europe/Sofia'`;
  const trendStart = sql`(((now() AT TIME ZONE 'Europe/Sofia')::date) - make_interval(days => ${TREND_DAYS - 1})) AT TIME ZONE 'Europe/Sofia'`;

  // Realised sales = not cancelled and not returned. Reused across every
  // sales aggregate so orders / revenue / AOV share one population.
  const realised = sql`${o.status} NOT IN ('cancelled', 'returned')`;

  const [ordersAgg, productsAgg, categoriesAgg, customersAgg, seriesRaw, lowStock, recent] =
    await Promise.all([
      // One pass over `orders` for the six order-derived scalars.
      db.execute(sql`
        SELECT
          (count(*) FILTER (WHERE ${o.createdAt} >= ${monthStart} AND ${realised}))::int AS month_orders,
          (coalesce(sum(${o.totalCents}) FILTER (WHERE ${o.createdAt} >= ${monthStart} AND ${realised}), 0))::bigint AS month_revenue,
          (count(*) FILTER (WHERE ${o.createdAt} >= ${todayStart} AND ${realised}))::int AS today_orders,
          (coalesce(sum(${o.totalCents}) FILTER (WHERE ${o.createdAt} >= ${todayStart} AND ${realised}), 0))::bigint AS today_revenue,
          (count(*) FILTER (WHERE ${o.status} = 'processing'))::int AS new_orders,
          (count(*) FILTER (WHERE ${o.status} = 'ready_for_pickup' AND ${o.pickupDeadline} < now()))::int AS expired_pickups
        FROM ${o}
      `),
      db.execute(sql`
        SELECT
          (count(*) FILTER (WHERE ${p.deletedAt} IS NULL))::int AS active_products,
          (count(*) FILTER (WHERE ${p.deletedAt} IS NULL AND ${p.stockStatus} = 'out_of_stock'))::int AS out_of_stock
        FROM ${p}
      `),
      db.execute(sql`
        SELECT (count(*) FILTER (WHERE ${cat.deletedAt} IS NULL))::int AS active_categories
        FROM ${cat}
      `),
      db.execute(sql`
        SELECT
          (count(*) FILTER (WHERE ${u.role} = 'customer' AND ${u.deletedAt} IS NULL))::int AS total_customers,
          (count(*) FILTER (WHERE ${u.role} = 'customer' AND ${u.deletedAt} IS NULL AND ${u.createdAt} >= ${monthStart}))::int AS month_new,
          (count(*) FILTER (WHERE ${u.role} = 'customer' AND ${u.deletedAt} IS NULL AND ${u.createdAt} >= ${todayStart}))::int AS today_new
        FROM ${u}
      `),
      // Grouped realised-sales per Sofia calendar day over the trend window.
      db.execute(sql`
        SELECT
          (${o.createdAt} AT TIME ZONE 'Europe/Sofia')::date::text AS date,
          (count(*) FILTER (WHERE ${realised}))::int AS orders,
          (coalesce(sum(${o.totalCents}) FILTER (WHERE ${realised}), 0))::bigint AS revenue
        FROM ${o}
        WHERE ${o.createdAt} >= ${trendStart}
        GROUP BY 1
        ORDER BY 1
      `),
      db
        .select({ id: p.id, name: p.name, code: p.code })
        .from(p)
        .where(and(isNull(p.deletedAt), eq(p.stockStatus, "out_of_stock")))
        .orderBy(desc(p.updatedAt))
        .limit(LOW_STOCK_ITEMS),
      db
        .select({
          orderNumber: o.orderNumber,
          status: o.status,
          customerName: o.customerName,
          totalCents: o.totalCents,
          createdAt: o.createdAt,
        })
        .from(o)
        .orderBy(desc(o.createdAt))
        .limit(RECENT_ORDERS),
    ]);

  const oa = pickFirstRow<{
    month_orders: number | string;
    month_revenue: number | string;
    today_orders: number | string;
    today_revenue: number | string;
    new_orders: number | string;
    expired_pickups: number | string;
  }>(ordersAgg);
  const pa = pickFirstRow<{ active_products: number | string; out_of_stock: number | string }>(
    productsAgg,
  );
  const ka = pickFirstRow<{ active_categories: number | string }>(categoriesAgg);
  const ua = pickFirstRow<{
    total_customers: number | string;
    month_new: number | string;
    today_new: number | string;
  }>(customersAgg);

  const monthOrders = Number(oa?.month_orders ?? 0);
  const monthRevenue = Number(oa?.month_revenue ?? 0);
  const todayOrders = Number(oa?.today_orders ?? 0);
  const todayRevenue = Number(oa?.today_revenue ?? 0);

  const seriesRows: DaySeriesRow[] = rowsOf<{
    date: string;
    orders: number | string;
    revenue: number | string;
  }>(seriesRaw).map((r) => ({
    date: r.date,
    orders: Number(r.orders),
    revenueCents: Number(r.revenue),
  }));

  // Admin PII read (recent-orders feed carries customer names): log the access.
  log.info({ event: "admin_dashboard_viewed", adminId: admin.id }, "admin_dashboard_viewed");

  return c.json(
    {
      generatedAt: new Date().toISOString(),
      timezone: "Europe/Sofia",
      month: {
        orders: monthOrders,
        revenueCents: monthRevenue,
        averageOrderValueCents: averageOrderValueCents(monthRevenue, monthOrders),
      },
      today: { orders: todayOrders, revenueCents: todayRevenue },
      newCustomers: {
        today: Number(ua?.today_new ?? 0),
        month: Number(ua?.month_new ?? 0),
      },
      actionQueue: {
        newOrders: Number(oa?.new_orders ?? 0),
        expiredPickups: Number(oa?.expired_pickups ?? 0),
        outOfStockProducts: Number(pa?.out_of_stock ?? 0),
      },
      catalog: {
        activeProducts: Number(pa?.active_products ?? 0),
        activeCategories: Number(ka?.active_categories ?? 0),
        totalCustomers: Number(ua?.total_customers ?? 0),
      },
      lowStock: lowStock.map((r) => ({ id: r.id, name: r.name, code: r.code })),
      recentOrders: recent.map((r) => ({
        orderNumber: r.orderNumber,
        status: r.status,
        customerName: r.customerName,
        totalCents: Number(r.totalCents),
        createdAt: r.createdAt.toISOString(),
      })),
      dailySeries: buildDaySeries(sofiaDate(new Date()), TREND_DAYS, seriesRows),
    },
    200,
  );
});
