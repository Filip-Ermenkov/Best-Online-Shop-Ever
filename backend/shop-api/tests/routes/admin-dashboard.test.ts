import { randomUUID } from "node:crypto";
import { hashPassword } from "@shop/auth";
import { schema } from "@shop/db";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { sessionCookieName } from "../../src/lib/cookies.js";
import { sofiaDate } from "../../src/lib/dashboard-metrics.js";
import { getDb } from "../../src/lib/db.js";
import { createSession } from "../../src/lib/sessions.js";
import type { DashboardSummary } from "../../src/routes/admin/dashboard.js";

/**
 * Integration tests for the admin dashboard slice (routes/admin/dashboard.ts):
 * the requireAdmin gate, the realised-sales KPIs (cancelled/returned excluded,
 * AOV coherent), the Europe/Sofia period bounds, the operational action queue,
 * the catalog snapshot, the recent-orders feed, the out-of-stock list, and the
 * 14-day trend. Exercised against the live route + real Postgres.
 */

let app: ReturnType<typeof buildApp>;

beforeAll(() => {
  app = buildApp();
});

const PASSWORD = "correct horse battery staple";
const DAY = 24 * 60 * 60 * 1000;

function cookieHeader(token: string): string {
  return `${sessionCookieName()}=${token}`;
}

async function seedAdmin(
  email = "admin@shop.bg",
): Promise<{ cookie: string; id: string }> {
  const db = getDb();
  const [user] = await db
    .insert(schema.users)
    .values({
      email: email.toLowerCase(),
      passwordHash: await hashPassword(PASSWORD),
      role: "admin",
      accountType: null,
      emailVerifiedAt: new Date(),
      mfaEnabled: true,
    })
    .returning();
  if (!user) throw new Error("admin seed failed");
  const { token } = await createSession({
    userId: user.id,
    rememberMe: false,
    role: "admin",
    ipAddress: null,
    userAgent: null,
  });
  return { cookie: cookieHeader(token), id: user.id };
}

async function seedCustomerSession(): Promise<string> {
  const db = getDb();
  const [user] = await db
    .insert(schema.users)
    .values({
      email: "cust-session@example.com",
      passwordHash: await hashPassword(PASSWORD),
      role: "customer",
      accountType: "personal",
      emailVerifiedAt: new Date(),
    })
    .returning();
  if (!user) throw new Error("customer session seed failed");
  const { token } = await createSession({
    userId: user.id,
    rememberMe: false,
    role: "customer",
    ipAddress: null,
    userAgent: null,
  });
  return cookieHeader(token);
}

async function seedCustomer(opts: {
  email: string;
  createdAt?: Date;
  deletedAt?: Date;
}): Promise<void> {
  const db = getDb();
  await db.insert(schema.users).values({
    email: opts.email.toLowerCase(),
    passwordHash: await hashPassword(PASSWORD),
    role: "customer",
    accountType: "personal",
    emailVerifiedAt: new Date(),
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    ...(opts.deletedAt ? { deletedAt: opts.deletedAt } : {}),
  });
}

let orderSeq = 0;
async function seedOrder(opts: {
  status?:
    | "processing"
    | "shipped"
    | "ready_for_pickup"
    | "delivered"
    | "accepted"
    | "returned"
    | "cancelled";
  totalCents?: number;
  createdAt?: Date;
  pickupDeadline?: Date;
  customerName?: string;
}): Promise<void> {
  const db = getDb();
  const total = opts.totalCents ?? 1000;
  orderSeq += 1;
  await db.insert(schema.orders).values({
    orderNumber: `2026-07-${String(orderSeq).padStart(5, "0")}`,
    customerId: null,
    idempotencyKey: randomUUID(),
    status: opts.status ?? "processing",
    paymentMethod: "cash_on_delivery",
    customerEmail: "kupuvach@example.com",
    customerName: opts.customerName ?? "Иван Купувача",
    customerPhone: "+359888123456",
    subtotalCents: String(total),
    totalCents: String(total),
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    ...(opts.pickupDeadline ? { pickupDeadline: opts.pickupDeadline } : {}),
  });
}

async function getDashboard(cookie: string) {
  const res = await app.request("/admin/dashboard", { headers: { cookie } });
  return res;
}

// ─── requireAdmin gate ─────────────────────────────────────────────────────────

describe("GET /admin/dashboard — auth gate", () => {
  it("returns 404 with no session (uniform admin-surface 404)", async () => {
    const res = await app.request("/admin/dashboard");
    expect(res.status).toBe(404);
  });

  it("returns 404 for a logged-in non-admin", async () => {
    const cookie = await seedCustomerSession();
    const res = await getDashboard(cookie);
    expect(res.status).toBe(404);
  });
});

// ─── Empty state ────────────────────────────────────────────────────────────────

describe("GET /admin/dashboard — empty shop", () => {
  it("returns all-zero KPIs and a 14-point zero series", async () => {
    const { cookie } = await seedAdmin();
    const res = await getDashboard(cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DashboardSummary;

    expect(body.timezone).toBe("Europe/Sofia");
    expect(body.month).toEqual({
      orders: 0,
      revenueCents: 0,
      averageOrderValueCents: 0,
    });
    expect(body.today).toEqual({ orders: 0, revenueCents: 0 });
    expect(body.newCustomers).toEqual({ today: 0, month: 0 });
    expect(body.actionQueue).toEqual({
      newOrders: 0,
      expiredPickups: 0,
      outOfStockProducts: 0,
    });
    expect(body.catalog).toEqual({
      activeProducts: 0,
      activeCategories: 0,
      totalCustomers: 0,
    });
    expect(body.lowStock).toEqual([]);
    expect(body.recentOrders).toEqual([]);
    expect(body.dailySeries).toHaveLength(14);
    expect(body.dailySeries.every((p: { orders: number }) => p.orders === 0)).toBe(true);
    // The last point is today (Europe/Sofia).
    expect(body.dailySeries[13]!.date).toBe(sofiaDate(new Date()));
  });
});

// ─── Realised-sales KPIs ────────────────────────────────────────────────────────

describe("GET /admin/dashboard — realised sales", () => {
  it("sums non-cancelled/non-returned orders and computes a coherent AOV", async () => {
    const { cookie } = await seedAdmin();
    // Realised sales: 10000 + 20000 + 5000 = 35000 over 3 orders.
    await seedOrder({ status: "delivered", totalCents: 10000 });
    await seedOrder({ status: "accepted", totalCents: 20000 });
    await seedOrder({ status: "shipped", totalCents: 5000 });
    // Excluded from sales.
    await seedOrder({ status: "cancelled", totalCents: 99999 });
    await seedOrder({ status: "returned", totalCents: 88888 });

    const body = (await (await getDashboard(cookie)).json()) as DashboardSummary;
    expect(body.month.orders).toBe(3);
    expect(body.month.revenueCents).toBe(35000);
    expect(body.month.averageOrderValueCents).toBe(Math.round(35000 / 3)); // 11667
    // All were placed "now", so today mirrors month here.
    expect(body.today).toEqual({ orders: 3, revenueCents: 35000 });
    // None are `processing`, so the action queue's newOrders stays 0.
    expect(body.actionQueue.newOrders).toBe(0);
  });

  it("excludes orders placed before the current Sofia month / day", async () => {
    const { cookie } = await seedAdmin();
    await seedOrder({ status: "delivered", totalCents: 10000 }); // now
    // 40 days > the longest month, so this is always a previous month.
    await seedOrder({
      status: "delivered",
      totalCents: 99999,
      createdAt: new Date(Date.now() - 40 * DAY),
    });

    const body = (await (await getDashboard(cookie)).json()) as DashboardSummary;
    expect(body.month.orders).toBe(1);
    expect(body.month.revenueCents).toBe(10000);
    expect(body.today.orders).toBe(1);
  });
});

// ─── 14-day trend ───────────────────────────────────────────────────────────────

describe("GET /admin/dashboard — daily trend", () => {
  it("bins realised sales by Sofia day and excludes anything older than the window", async () => {
    const { cookie } = await seedAdmin();
    const fiveDaysAgo = new Date(Date.now() - 5 * DAY);
    await seedOrder({ status: "delivered", totalCents: 10000 }); // today
    await seedOrder({ status: "delivered", totalCents: 20000, createdAt: fiveDaysAgo });
    await seedOrder({
      status: "delivered",
      totalCents: 99999,
      createdAt: new Date(Date.now() - 40 * DAY), // outside the 14-day window
    });

    const body = (await (await getDashboard(cookie)).json()) as DashboardSummary;
    expect(body.dailySeries).toHaveLength(14);

    const today = body.dailySeries.find(
      (p: { date: string }) => p.date === sofiaDate(new Date()),
    );
    expect(today!.orders).toBe(1);
    expect(today!.revenueCents).toBe(10000);

    const past = body.dailySeries.find(
      (p: { date: string }) => p.date === sofiaDate(fiveDaysAgo),
    );
    expect(past!.orders).toBe(1);
    expect(past!.revenueCents).toBe(20000);

    // The 40-days-ago order never appears in the window.
    const totalOrders = body.dailySeries.reduce(
      (s: number, p: { orders: number }) => s + p.orders,
      0,
    );
    expect(totalOrders).toBe(2);
  });
});

// ─── Action queue ───────────────────────────────────────────────────────────────

describe("GET /admin/dashboard — action queue", () => {
  it("counts new orders, expired pickups, and out-of-stock products", async () => {
    const { cookie } = await seedAdmin();
    await seedOrder({ status: "processing" });
    await seedOrder({ status: "processing" });
    await seedOrder({
      status: "ready_for_pickup",
      pickupDeadline: new Date(Date.now() - DAY), // expired
    });
    await seedOrder({
      status: "ready_for_pickup",
      pickupDeadline: new Date(Date.now() + DAY), // still valid
    });

    const cat = await getDb()
      .insert(schema.categories)
      .values({ slug: "c", name: "Кат", displayOrder: 0 })
      .returning();
    const catId = cat[0]!.id;
    await getDb().insert(schema.products).values([
      { slug: "p1", code: "P1", name: "Прод 1", priceCents: "1000", categoryId: catId, stockStatus: "out_of_stock" },
      { slug: "p2", code: "P2", name: "Прод 2", priceCents: "1000", categoryId: catId, stockStatus: "out_of_stock" },
      { slug: "p3", code: "P3", name: "Прод 3", priceCents: "1000", categoryId: catId, stockStatus: "in_stock" },
      // A soft-deleted out-of-stock product must NOT count.
      { slug: "p4", code: "P4", name: "Прод 4", priceCents: "1000", categoryId: catId, stockStatus: "out_of_stock", deletedAt: new Date() },
    ]);

    const body = (await (await getDashboard(cookie)).json()) as DashboardSummary;
    expect(body.actionQueue.newOrders).toBe(2);
    expect(body.actionQueue.expiredPickups).toBe(1);
    expect(body.actionQueue.outOfStockProducts).toBe(2);
  });
});

// ─── Catalog snapshot + low-stock list ──────────────────────────────────────────

describe("GET /admin/dashboard — catalog snapshot", () => {
  it("counts active products/categories/customers and lists out-of-stock items", async () => {
    const { cookie } = await seedAdmin();

    const cat = await getDb()
      .insert(schema.categories)
      .values([
        { slug: "a", name: "Активна", displayOrder: 0 },
        { slug: "d", name: "Изтрита", displayOrder: 1, deletedAt: new Date() },
      ])
      .returning();
    const activeCatId = cat[0]!.id;

    await getDb().insert(schema.products).values([
      { slug: "x1", code: "X1", name: "Наличен", priceCents: "1000", categoryId: activeCatId, stockStatus: "in_stock" },
      { slug: "x2", code: "X2", name: "Изчерпан", priceCents: "1000", categoryId: activeCatId, stockStatus: "out_of_stock" },
      { slug: "x3", code: "X3", name: "Изтрит", priceCents: "1000", categoryId: activeCatId, stockStatus: "in_stock", deletedAt: new Date() },
    ]);

    await seedCustomer({ email: "c1@example.com" });
    await seedCustomer({ email: "c2@example.com" });
    await seedCustomer({ email: "gone@example.com", deletedAt: new Date() });

    const body = (await (await getDashboard(cookie)).json()) as DashboardSummary;
    // 2 active products (x3 soft-deleted excluded).
    expect(body.catalog.activeProducts).toBe(2);
    // 1 active category (the deleted one excluded).
    expect(body.catalog.activeCategories).toBe(1);
    // 2 live customers — the admin (role=admin) and the deleted one excluded.
    expect(body.catalog.totalCustomers).toBe(2);

    expect(body.lowStock).toHaveLength(1);
    expect(body.lowStock[0]).toMatchObject({ name: "Изчерпан", code: "X2" });
    expect(typeof body.lowStock[0]!.id).toBe("string");
  });
});

// ─── New customers ──────────────────────────────────────────────────────────────

describe("GET /admin/dashboard — new customers", () => {
  it("counts customers registered this Sofia month/today, excluding older ones", async () => {
    const { cookie } = await seedAdmin();
    await seedCustomer({ email: "fresh@example.com" }); // now
    await seedCustomer({
      email: "old@example.com",
      createdAt: new Date(Date.now() - 40 * DAY),
    });

    const body = (await (await getDashboard(cookie)).json()) as DashboardSummary;
    expect(body.catalog.totalCustomers).toBe(2);
    expect(body.newCustomers.month).toBe(1);
    expect(body.newCustomers.today).toBe(1);
  });
});

// ─── Recent orders feed ─────────────────────────────────────────────────────────

describe("GET /admin/dashboard — recent orders", () => {
  it("returns the newest 8 orders (any status), newest-first", async () => {
    const { cookie } = await seedAdmin();
    // 10 orders, oldest → newest by createdAt.
    for (let i = 0; i < 10; i++) {
      await seedOrder({
        status: i === 0 ? "cancelled" : "delivered",
        totalCents: 1000 + i,
        createdAt: new Date(Date.now() - (10 - i) * 60 * 1000),
        customerName: `Клиент ${i}`,
      });
    }

    const body = (await (await getDashboard(cookie)).json()) as DashboardSummary;
    expect(body.recentOrders).toHaveLength(8);
    // Newest first: the last-seeded (i=9) leads.
    expect(body.recentOrders[0]!.customerName).toBe("Клиент 9");
    // Descending createdAt across the feed.
    const times = body.recentOrders.map((o: { createdAt: string }) =>
      new Date(o.createdAt).getTime(),
    );
    const sorted = [...times].sort((a, b) => b - a);
    expect(times).toEqual(sorted);
  });
});
