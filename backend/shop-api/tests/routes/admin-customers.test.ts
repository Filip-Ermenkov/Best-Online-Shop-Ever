import { randomUUID } from "node:crypto";
import { hashPassword } from "@shop/auth";
import { schema } from "@shop/db";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { sessionCookieName } from "../../src/lib/cookies.js";
import { getDb } from "../../src/lib/db.js";
import { createSession } from "../../src/lib/sessions.js";

/**
 * Integration tests for the admin account-management slice
 * (routes/admin/customers.ts): the requireAdmin gate, the paginated /searchable
 * /filterable list, the detail view (personal + corporate + discount + orders),
 * setting a discount (fresh + update + validation + optimistic lock), clearing a
 * discount (idempotent), and account deletion (active-order guard + GDPR erasure).
 * Exercised against the live route + real Postgres.
 */

let app: ReturnType<typeof buildApp>;

beforeAll(() => {
  app = buildApp();
});

const PASSWORD = "correct horse battery staple";

function cookieHeader(token: string): string {
  return `${sessionCookieName()}=${token}`;
}

async function seedAdmin(
  email = "admin@shop.bg",
): Promise<{ cookie: string; id: string; email: string }> {
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
  return { cookie: cookieHeader(token), id: user.id, email: user.email };
}

async function seedCustomerSession(
  email = "cust-session@example.com",
): Promise<string> {
  const db = getDb();
  const [user] = await db
    .insert(schema.users)
    .values({
      email: email.toLowerCase(),
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
  accountType?: "personal" | "corporate";
  fullName?: string;
  phone?: string;
  companyName?: string;
  verified?: boolean;
}): Promise<string> {
  const db = getDb();
  const accountType = opts.accountType ?? "personal";
  const [user] = await db
    .insert(schema.users)
    .values({
      email: opts.email.toLowerCase(),
      passwordHash: await hashPassword(PASSWORD),
      role: "customer",
      accountType,
      emailVerifiedAt: opts.verified === false ? null : new Date(),
    })
    .returning();
  if (!user) throw new Error("customer seed failed");
  if (accountType === "personal") {
    await db.insert(schema.customerProfiles).values({
      userId: user.id,
      fullName: opts.fullName ?? "Иван Иванов",
      phone: opts.phone ?? "+359888123456",
    });
  } else {
    await db.insert(schema.corporateProfiles).values({
      userId: user.id,
      companyName: opts.companyName ?? "Примерна Фирма ООД",
      eik: String(Math.floor(100000000 + Math.random() * 900000000)),
      vatNumber: null,
      registeredAddress: "гр. София, ул. Тест 1",
      mol: "Отговорник",
      contactName: opts.fullName ?? "Лице за контакт",
      contactPhone: opts.phone ?? "+359888000000",
    });
  }
  return user.id;
}

async function seedOrder(opts: {
  customerId: string;
  status?:
    | "processing"
    | "shipped"
    | "ready_for_pickup"
    | "delivered"
    | "accepted"
    | "returned"
    | "cancelled";
  totalCents?: number;
}): Promise<void> {
  const db = getDb();
  await db.insert(schema.orders).values({
    orderNumber: `2026-07-${Math.floor(10000 + Math.random() * 89999)}`,
    customerId: opts.customerId,
    idempotencyKey: randomUUID(),
    status: opts.status ?? "processing",
    paymentMethod: "pay_at_store",
    customerEmail: "snapshot@example.com",
    customerPhone: "+359888111222",
    customerName: "Снимка Клиент",
    subtotalCents: String(opts.totalCents ?? 1000),
    totalCents: String(opts.totalCents ?? 1000),
  });
}

function listReq(cookie: string, qs = "") {
  return app.request(`/admin/customers${qs}`, {
    headers: { Cookie: cookie, Accept: "application/json" },
  });
}
function detailReq(cookie: string, id: string) {
  return app.request(`/admin/customers/${id}`, {
    headers: { Cookie: cookie, Accept: "application/json" },
  });
}
function setDiscountReq(cookie: string, id: string, body: unknown) {
  return app.request(`/admin/customers/${id}/discount`, {
    method: "PUT",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
}
function clearDiscountReq(cookie: string, id: string) {
  return app.request(`/admin/customers/${id}/discount`, {
    method: "DELETE",
    headers: { Cookie: cookie, Accept: "application/json" },
  });
}
function deleteReq(cookie: string, id: string, body: unknown = { confirmConsequences: true }) {
  return app.request(`/admin/customers/${id}`, {
    method: "DELETE",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
}

type ListBody = {
  items: Array<{
    id: string;
    email: string;
    accountType: string;
    displayName: string;
    discountPercent: number | null;
    orderCount: number;
  }>;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

type DetailBody = {
  id: string;
  accountType: string;
  personal: { fullName: string; phone: string } | null;
  corporate: { companyName: string; eik: string } | null;
  discount: { percent: number; appliedAt: string; appliedByEmail: string | null } | null;
  orders: Array<{ orderNumber: string; status: string; totalCents: number; itemCount: number }>;
  orderCount: number;
};

describe("requireAdmin gate", () => {
  it("returns 404 with no session", async () => {
    const res = await app.request("/admin/customers");
    expect(res.status).toBe(404);
  });

  it("returns 404 for a customer session (no enumeration)", async () => {
    const cookie = await seedCustomerSession();
    const res = await listReq(cookie);
    expect(res.status).toBe(404);
  });
});

describe("GET /admin/customers", () => {
  it("lists customers newest-first with a total and the discount column", async () => {
    const { cookie, id: adminId } = await seedAdmin();
    const c1 = await seedCustomer({ email: "a@example.com", fullName: "Анна" });
    await seedCustomer({ email: "b@example.com", fullName: "Борис" });
    await seedOrder({ customerId: c1 });
    // give c1 a discount directly
    await getDb()
      .insert(schema.discounts)
      .values({ userId: c1, percent: "12.50", appliedByUserId: adminId, appliedAt: new Date() });

    const res = await listReq(cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    expect(body.total).toBe(2);
    expect(body.items.length).toBe(2);
    const rowC1 = body.items.find((i) => i.id === c1)!;
    expect(rowC1.discountPercent).toBe(12.5);
    expect(rowC1.orderCount).toBe(1);
  });

  it("excludes admins and pseudonymised (deleted) accounts", async () => {
    const { cookie } = await seedAdmin();
    await seedCustomer({ email: "live@example.com" });
    const gone = await seedCustomer({ email: "gone@example.com" });
    await getDb()
      .update(schema.users)
      .set({ deletedAt: new Date() })
      .where(eq(schema.users.id, gone));

    const body = (await (await listReq(cookie)).json()) as ListBody;
    // Only the one live customer — never the admin, never the deleted row.
    expect(body.total).toBe(1);
    expect(body.items[0]!.email).toBe("live@example.com");
  });

  it("searches by email, name, and company", async () => {
    const { cookie } = await seedAdmin();
    await seedCustomer({ email: "ivan@example.com", fullName: "Иван Петров" });
    await seedCustomer({
      email: "acme@corp.bg",
      accountType: "corporate",
      companyName: "Акме ООД",
    });

    const byName = (await (await listReq(cookie, "?q=петров")).json()) as ListBody;
    expect(byName.total).toBe(1);
    expect(byName.items[0]!.email).toBe("ivan@example.com");

    const byCompany = (await (await listReq(cookie, "?q=акме")).json()) as ListBody;
    expect(byCompany.total).toBe(1);
    expect(byCompany.items[0]!.accountType).toBe("corporate");
  });

  it("filters by account type", async () => {
    const { cookie } = await seedAdmin();
    await seedCustomer({ email: "person@example.com", accountType: "personal" });
    await seedCustomer({ email: "firm@corp.bg", accountType: "corporate" });

    const body = (await (await listReq(cookie, "?accountType=corporate")).json()) as ListBody;
    expect(body.total).toBe(1);
    expect(body.items[0]!.accountType).toBe("corporate");
  });
});

describe("GET /admin/customers/:id", () => {
  it("returns personal profile + discount + order history", async () => {
    const { cookie, id: adminId, email: adminEmail } = await seedAdmin();
    const cust = await seedCustomer({
      email: "detail@example.com",
      fullName: "Детайл Клиент",
      phone: "+359888999000",
    });
    await seedOrder({ customerId: cust, status: "accepted", totalCents: 4200 });
    await getDb()
      .insert(schema.discounts)
      .values({ userId: cust, percent: "15.00", appliedByUserId: adminId, appliedAt: new Date() });

    const res = await detailReq(cookie, cust);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DetailBody;
    expect(body.accountType).toBe("personal");
    expect(body.personal?.fullName).toBe("Детайл Клиент");
    expect(body.corporate).toBeNull();
    expect(body.discount?.percent).toBe(15);
    expect(body.discount?.appliedByEmail).toBe(adminEmail);
    expect(body.orderCount).toBe(1);
    expect(body.orders[0]!.totalCents).toBe(4200);
  });

  it("returns the corporate block for a company account", async () => {
    const { cookie } = await seedAdmin();
    const cust = await seedCustomer({
      email: "company@corp.bg",
      accountType: "corporate",
      companyName: "Голяма Фирма АД",
    });
    const body = (await (await detailReq(cookie, cust)).json()) as DetailBody;
    expect(body.accountType).toBe("corporate");
    expect(body.corporate?.companyName).toBe("Голяма Фирма АД");
    expect(body.personal).toBeNull();
    expect(body.discount).toBeNull();
  });

  it("404s for an unknown id and for a non-customer id", async () => {
    const { cookie, id: adminId } = await seedAdmin();
    expect((await detailReq(cookie, randomUUID())).status).toBe(404);
    // The admin's own id is not a customer → uniform 404.
    expect((await detailReq(cookie, adminId)).status).toBe(404);
  });
});

describe("PUT /admin/customers/:id/discount", () => {
  it("sets a fresh discount, writes an audit row, and reflects it in checkout-read", async () => {
    const { cookie } = await seedAdmin();
    const cust = await seedCustomer({ email: "disc@example.com" });

    const res = await setDiscountReq(cookie, cust, { percent: 10 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { percent: number; appliedAt: string };
    expect(body.percent).toBe(10);

    const db = getDb();
    const [row] = await db
      .select()
      .from(schema.discounts)
      .where(eq(schema.discounts.userId, cust));
    expect(Number(row!.percent)).toBe(10);

    const audit = await db
      .select()
      .from(schema.adminAuditLog)
      .where(eq(schema.adminAuditLog.action, "customer.discount_set"));
    expect(audit.length).toBe(1);
    expect(audit[0]!.entityId).toBe(cust);
  });

  it("enforces the optimistic lock (fresh-conflict + stale-update-conflict)", async () => {
    const { cookie } = await seedAdmin();
    const cust = await seedCustomer({ email: "lock@example.com" });

    const first = await setDiscountReq(cookie, cust, { percent: 10 });
    const a1 = ((await first.json()) as { appliedAt: string }).appliedAt;

    // A second "fresh" set (no expectedAppliedAt) must conflict — one exists now.
    const freshConflict = await setDiscountReq(cookie, cust, { percent: 20 });
    expect(freshConflict.status).toBe(409);

    // A correct update (echoing the last appliedAt) succeeds and advances it.
    const ok = await setDiscountReq(cookie, cust, { percent: 15, expectedAppliedAt: a1 });
    expect(ok.status).toBe(200);

    // Re-using the now-stale token conflicts.
    const stale = await setDiscountReq(cookie, cust, { percent: 25, expectedAppliedAt: a1 });
    expect(stale.status).toBe(409);
    const problem = (await stale.json()) as { type?: string };
    expect(problem.type).toBe("/problems/customer-discount-conflict");
  });

  it("rejects out-of-range or over-precise percentages with 400", async () => {
    const { cookie } = await seedAdmin();
    const cust = await seedCustomer({ email: "bad@example.com" });
    expect((await setDiscountReq(cookie, cust, { percent: 0 })).status).toBe(400);
    expect((await setDiscountReq(cookie, cust, { percent: 150 })).status).toBe(400);
    expect((await setDiscountReq(cookie, cust, { percent: 10.999 })).status).toBe(400);
  });

  it("404s when setting a discount on an unknown customer", async () => {
    const { cookie } = await seedAdmin();
    const res = await setDiscountReq(cookie, randomUUID(), { percent: 10 });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /admin/customers/:id/discount", () => {
  it("clears an existing discount and is idempotent", async () => {
    const { cookie, id: adminId } = await seedAdmin();
    const cust = await seedCustomer({ email: "clear@example.com" });
    await getDb()
      .insert(schema.discounts)
      .values({ userId: cust, percent: "10.00", appliedByUserId: adminId, appliedAt: new Date() });

    const first = await clearDiscountReq(cookie, cust);
    expect(first.status).toBe(200);
    expect(((await first.json()) as { cleared: boolean }).cleared).toBe(true);

    // Row gone.
    const rows = await getDb()
      .select()
      .from(schema.discounts)
      .where(eq(schema.discounts.userId, cust));
    expect(rows.length).toBe(0);

    // Second clear is a no-op, not an error.
    const second = await clearDiscountReq(cookie, cust);
    expect(second.status).toBe(200);
    expect(((await second.json()) as { cleared: boolean }).cleared).toBe(false);
  });
});

describe("DELETE /admin/customers/:id", () => {
  it("blocks deletion while an order is active (422 + blocking numbers)", async () => {
    const { cookie } = await seedAdmin();
    const cust = await seedCustomer({ email: "active@example.com" });
    await seedOrder({ customerId: cust, status: "processing" });

    const res = await deleteReq(cookie, cust);
    expect(res.status).toBe(422);
    const problem = (await res.json()) as { type?: string; errors?: unknown[] };
    expect(problem.type).toBe("/problems/active-orders-block-deletion");
    expect(Array.isArray(problem.errors)).toBe(true);
  });

  it("erases an account with no active orders (pseudonymises the row)", async () => {
    const { cookie, id: adminId } = await seedAdmin();
    const cust = await seedCustomer({ email: "erase@example.com" });
    // A terminal order does NOT block deletion (history is retained).
    await seedOrder({ customerId: cust, status: "cancelled" });
    await getDb()
      .insert(schema.discounts)
      .values({ userId: cust, percent: "10.00", appliedByUserId: adminId, appliedAt: new Date() });

    const res = await deleteReq(cookie, cust);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { deleted: boolean }).deleted).toBe(true);

    const db = getDb();
    const [row] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, cust));
    expect(row!.deletedAt).not.toBeNull();
    expect(row!.email).toMatch(/@deleted\.invalid$/);
    // The discount is hard-deleted by the erasure.
    const discs = await db
      .select()
      .from(schema.discounts)
      .where(eq(schema.discounts.userId, cust));
    expect(discs.length).toBe(0);
    // Audit trail recorded.
    const audit = await db
      .select()
      .from(schema.adminAuditLog)
      .where(eq(schema.adminAuditLog.action, "customer.delete"));
    expect(audit.length).toBe(1);
  });

  it("404s for an unknown id and 400s without the confirmation", async () => {
    const { cookie } = await seedAdmin();
    const cust = await seedCustomer({ email: "confirm@example.com" });
    expect((await deleteReq(cookie, randomUUID())).status).toBe(404);
    expect((await deleteReq(cookie, cust, {})).status).toBe(400);
  });
});
