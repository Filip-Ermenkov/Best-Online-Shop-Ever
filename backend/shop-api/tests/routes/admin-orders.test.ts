import { randomUUID } from "node:crypto";
import { hashPassword } from "@shop/auth";
import { schema } from "@shop/db";
import {
  ORDER_STATUS_UPDATE_TEMPLATE_ID,
  type EmailTransport,
} from "@shop/email";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { sessionCookieName } from "../../src/lib/cookies.js";
import { getDb } from "../../src/lib/db.js";
import {
  getStubTransportForTests,
  setEmailTransportForTests,
} from "../../src/lib/emails.js";
import { createSession } from "../../src/lib/sessions.js";

/**
 * Integration tests for the admin order-management slice
 * (routes/admin/orders.ts): list + filters + search + pagination, detail with
 * status history, the state-machine transition endpoint (optimistic locking,
 * audit entry, status-update email), and the CSV export (OWASP formula-
 * injection hardening).
 *
 * The state-machine table itself mirrors docs/README.md §7; every legal hop
 * and a representative set of illegal ones are exercised against the live
 * route, not the pure module, so middleware order / transaction wiring /
 * email wiring are all under test.
 */

let app: ReturnType<typeof buildApp>;

beforeAll(() => {
  app = buildApp();
});

const PASSWORD = "correct horse battery staple";

function cookieHeader(token: string): string {
  return `${sessionCookieName()}=${token}`;
}

async function seedAdminSession(email = "admin@shop.bg"): Promise<{
  cookie: string;
  adminId: string;
}> {
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
  // Mint the role-aware session directly — the full TOTP ceremony is already
  // covered by admin-auth.test.ts; these tests are about the orders surface.
  const { token } = await createSession({
    userId: user.id,
    rememberMe: false,
    role: "admin",
    ipAddress: null,
    userAgent: null,
  });
  return { cookie: cookieHeader(token), adminId: user.id };
}

async function seedCustomerSession(email = "ivan@example.com"): Promise<{
  cookie: string;
  userId: string;
}> {
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
  if (!user) throw new Error("customer seed failed");
  const { token } = await createSession({
    userId: user.id,
    rememberMe: false,
    role: "customer",
    ipAddress: null,
    userAgent: null,
  });
  return { cookie: cookieHeader(token), userId: user.id };
}

let orderSeq = 0;

interface MakeOrderOpts {
  status?: (typeof schema.orders.$inferSelect)["status"];
  paymentMethod?: "cash_on_delivery" | "pay_at_store";
  customerId?: string | null;
  customerEmail?: string;
  customerName?: string;
  customerPhone?: string;
  createdAt?: Date;
  pickupDeadline?: Date;
  withDelivery?: boolean;
  corporate?: { companyName: string };
  items?: { code: string; name: string; unitPriceCents: number; quantity: number }[];
}

/**
 * Insert an order directly (checkout is covered by orders.test.ts; here we
 * need precise control over status / payment / timestamps). Seeds the
 * `processing` history entry exactly like checkout does.
 */
async function makeOrder(opts: MakeOrderOpts = {}) {
  const db = getDb();
  orderSeq += 1;
  const orderNumber = `2099-01-${String(orderSeq).padStart(5, "0")}`;
  const items = opts.items ?? [
    { code: "PRD-1", name: "Перфоратор Bosch", unitPriceCents: 12_500, quantity: 1 },
  ];
  const subtotal = items.reduce((s, i) => s + i.unitPriceCents * i.quantity, 0);
  const [order] = await db
    .insert(schema.orders)
    .values({
      orderNumber,
      customerId: opts.customerId === undefined ? null : opts.customerId,
      idempotencyKey: randomUUID(),
      status: opts.status ?? "processing",
      paymentMethod: opts.paymentMethod ?? "cash_on_delivery",
      customerEmail: opts.customerEmail ?? "kupuvach@example.com",
      customerName: opts.customerName ?? "Иван Купувача",
      customerPhone: opts.customerPhone ?? "+359888123456",
      subtotalCents: String(subtotal),
      totalCents: String(subtotal),
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      ...(opts.pickupDeadline ? { pickupDeadline: opts.pickupDeadline } : {}),
    })
    .returning();
  if (!order) throw new Error("order seed failed");
  await db.insert(schema.orderItems).values(
    items.map((i) => ({
      orderId: order.id,
      productCode: i.code,
      productName: i.name,
      unitPriceCents: String(i.unitPriceCents),
      quantity: i.quantity,
    })),
  );
  if (opts.withDelivery) {
    await db.insert(schema.orderDeliveryAddress).values({
      orderId: order.id,
      city: "София",
      postalCode: "1000",
      street: "бул. Витоша 1",
    });
  }
  if (opts.corporate) {
    await db.insert(schema.orderCorporateData).values({
      orderId: order.id,
      companyName: opts.corporate.companyName,
      eik: "123456789",
      registeredAddress: "София, ул. Опълченска 1",
      mol: "Георги Георгиев",
      contactName: "Георги Георгиев",
    });
  }
  await db.insert(schema.orderStatusHistory).values({
    orderId: order.id,
    status: "processing",
    changedByUserId: opts.customerId ?? null,
  });
  return order;
}

function get(path: string, cookie?: string) {
  return app.request(path, {
    headers: cookie ? { Cookie: cookie } : {},
  });
}

function postStatus(orderNumber: string, body: unknown, cookie?: string) {
  return app.request(`/admin/orders/${orderNumber}/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

// ─── Authorization (uniform 404 on the admin surface) ────────────────────────

describe("admin orders — authorization", () => {
  it("returns a flat 404 for anonymous callers on every route", async () => {
    const order = await makeOrder();
    for (const res of await Promise.all([
      get("/admin/orders"),
      get(`/admin/orders/${order.orderNumber}`),
      get("/admin/orders/export.csv"),
      postStatus(order.orderNumber, { status: "cancelled", expectedVersion: 1 }),
    ])) {
      expect(res.status).toBe(404);
    }
  });

  it("returns the same flat 404 for a logged-in CUSTOMER (no enumeration)", async () => {
    const order = await makeOrder();
    const { cookie } = await seedCustomerSession();
    const list = await get("/admin/orders", cookie);
    expect(list.status).toBe(404);
    const transition = await postStatus(
      order.orderNumber,
      { status: "cancelled", expectedVersion: 1 },
      cookie,
    );
    expect(transition.status).toBe(404);
    // The order is untouched.
    const db = getDb();
    const [row] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, order.id));
    expect(row!.status).toBe("processing");
  });
});

// ─── GET /admin/orders (list) ────────────────────────────────────────────────

describe("GET /admin/orders", () => {
  it("returns an empty page when there are no orders", async () => {
    const { cookie } = await seedAdminSession();
    const res = await get("/admin/orders", cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: unknown[];
      total: number;
      totalPages: number;
    };
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.totalPages).toBe(0);
  });

  it("lists orders newest-first with summary fields incl. version + customerType", async () => {
    const older = await makeOrder({ createdAt: new Date("2099-01-01T10:00:00Z") });
    const newer = await makeOrder({
      createdAt: new Date("2099-01-02T10:00:00Z"),
      corporate: { companyName: "Дюда ООД" },
    });
    const admin = await seedAdminSession();
    const res = await get("/admin/orders", admin.cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: {
        orderNumber: string;
        version: number;
        customerType: string;
        companyName: string | null;
        totalCents: number;
        status: string;
      }[];
      total: number;
    };
    expect(body.total).toBe(2);
    expect(body.items.map((i) => i.orderNumber)).toEqual([
      newer.orderNumber,
      older.orderNumber,
    ]);
    const first = body.items[0]!;
    expect(first.version).toBe(1);
    expect(first.customerType).toBe("corporate");
    expect(first.companyName).toBe("Дюда ООД");
    expect(first.totalCents).toBe(12_500);
    // No customer account linked → guest.
    expect(body.items[1]!.customerType).toBe("guest");
  });

  it("paginates at the requested pageSize and reports the page count", async () => {
    for (let i = 0; i < 7; i++) {
      await makeOrder({ createdAt: new Date(Date.UTC(2099, 0, 10 + i)) });
    }
    const { cookie } = await seedAdminSession();
    const page1 = (await (await get("/admin/orders?pageSize=3", cookie)).json()) as {
      items: { orderNumber: string }[];
      total: number;
      totalPages: number;
      page: number;
    };
    expect(page1.total).toBe(7);
    expect(page1.totalPages).toBe(3);
    expect(page1.items).toHaveLength(3);
    const page3 = (await (
      await get("/admin/orders?pageSize=3&page=3", cookie)
    ).json()) as { items: { orderNumber: string }[]; page: number };
    expect(page3.items).toHaveLength(1);
    // No overlap between pages (stable createdAt DESC, id tiebreak).
    const all = new Set([
      ...page1.items.map((i) => i.orderNumber),
      ...page3.items.map((i) => i.orderNumber),
    ]);
    expect(all.size).toBe(4);
  });

  it("filters by status and paymentMethod", async () => {
    await makeOrder({ status: "processing", paymentMethod: "cash_on_delivery" });
    const shipped = await makeOrder({
      status: "shipped",
      paymentMethod: "cash_on_delivery",
    });
    const pickup = await makeOrder({
      status: "processing",
      paymentMethod: "pay_at_store",
    });
    const { cookie } = await seedAdminSession();

    const byStatus = (await (
      await get("/admin/orders?status=shipped", cookie)
    ).json()) as { items: { orderNumber: string }[]; total: number };
    expect(byStatus.total).toBe(1);
    expect(byStatus.items[0]!.orderNumber).toBe(shipped.orderNumber);

    const byPayment = (await (
      await get("/admin/orders?paymentMethod=pay_at_store", cookie)
    ).json()) as { items: { orderNumber: string }[]; total: number };
    expect(byPayment.total).toBe(1);
    expect(byPayment.items[0]!.orderNumber).toBe(pickup.orderNumber);
  });

  it("filters by customerType (guest / personal / corporate)", async () => {
    const { userId } = await seedCustomerSession("buyer2@example.com");
    const guest = await makeOrder({ customerId: null });
    const personal = await makeOrder({ customerId: userId });
    const corporate = await makeOrder({
      customerId: userId,
      corporate: { companyName: "Фирма ЕООД" },
    });
    const { cookie } = await seedAdminSession();

    for (const [type, expected] of [
      ["guest", guest.orderNumber],
      ["personal", personal.orderNumber],
      ["corporate", corporate.orderNumber],
    ] as const) {
      const body = (await (
        await get(`/admin/orders?customerType=${type}`, cookie)
      ).json()) as { items: { orderNumber: string }[]; total: number };
      expect(body.total).toBe(1);
      expect(body.items[0]!.orderNumber).toBe(expected);
    }
  });

  it("searches across order number, email, phone, and company name", async () => {
    const byNumber = await makeOrder();
    const byEmail = await makeOrder({ customerEmail: "special-needle@example.com" });
    const byPhone = await makeOrder({ customerPhone: "+359877999888" });
    const byCompany = await makeOrder({
      corporate: { companyName: "Иголка Трейд ООД" },
    });
    const { cookie } = await seedAdminSession();

    for (const [q, expected] of [
      [byNumber.orderNumber, byNumber.orderNumber],
      ["special-needle", byEmail.orderNumber],
      ["877999", byPhone.orderNumber],
      ["Иголка", byCompany.orderNumber],
    ] as const) {
      const body = (await (
        await get(`/admin/orders?q=${encodeURIComponent(q)}`, cookie)
      ).json()) as { items: { orderNumber: string }[]; total: number };
      expect(body.total).toBe(1);
      expect(body.items[0]!.orderNumber).toBe(expected);
    }
  });

  it("filters by an inclusive Europe/Sofia calendar-date range", async () => {
    // 2099-03-01 21:30 UTC = 2099-03-01 23:30 Sofia (EET, UTC+2) → in range.
    // 2099-03-01 22:30 UTC = 2099-03-02 00:30 Sofia → OUT of a to=2099-03-01 range.
    const inside = await makeOrder({
      createdAt: new Date("2099-03-01T21:30:00Z"),
    });
    await makeOrder({ createdAt: new Date("2099-03-01T22:30:00Z") });
    await makeOrder({ createdAt: new Date("2099-02-28T10:00:00Z") });
    const { cookie } = await seedAdminSession();
    const body = (await (
      await get("/admin/orders?from=2099-03-01&to=2099-03-01", cookie)
    ).json()) as { items: { orderNumber: string }[]; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]!.orderNumber).toBe(inside.orderNumber);
  });
});

// ─── GET /admin/orders/:orderNumber (detail) ─────────────────────────────────

describe("GET /admin/orders/:orderNumber", () => {
  it("returns the full detail: items, snapshots, history, allowedTargets", async () => {
    const order = await makeOrder({
      paymentMethod: "cash_on_delivery",
      withDelivery: true,
      corporate: { companyName: "Детайл ООД" },
      items: [
        { code: "A-1", name: "Болт M8", unitPriceCents: 50, quantity: 100 },
        { code: "B-2", name: "Гайка M8", unitPriceCents: 30, quantity: 100 },
      ],
    });
    const { cookie } = await seedAdminSession();
    const res = await get(`/admin/orders/${order.orderNumber}`, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      orderNumber: string;
      version: number;
      items: { productCode: string; quantity: number }[];
      deliveryAddress: { city: string } | null;
      corporateData: { companyName: string } | null;
      statusHistory: { status: string; changedByEmail: string | null }[];
      allowedTargets: string[];
      subtotalCents: number;
    };
    expect(body.orderNumber).toBe(order.orderNumber);
    expect(body.version).toBe(1);
    expect(body.items).toHaveLength(2);
    expect(body.subtotalCents).toBe(50 * 100 + 30 * 100);
    expect(body.deliveryAddress?.city).toBe("София");
    expect(body.corporateData?.companyName).toBe("Детайл ООД");
    expect(body.statusHistory).toHaveLength(1);
    expect(body.statusHistory[0]!.status).toBe("processing");
    // processing × cash_on_delivery → shipped or cancelled.
    expect(body.allowedTargets.sort()).toEqual(["cancelled", "shipped"]);
  });

  it("404s with /problems/order-not-found for an unknown number", async () => {
    const { cookie } = await seedAdminSession();
    const res = await get("/admin/orders/2099-01-99999", cookie);
    expect(res.status).toBe(404);
    const problem = (await res.json()) as { type: string };
    expect(problem.type).toBe("/problems/order-not-found");
  });
});

// ─── POST /admin/orders/:orderNumber/status ──────────────────────────────────

describe("POST /admin/orders/:orderNumber/status — state machine", () => {
  it("processing → shipped (COD): stores courier fields, bumps version, audits, emails", async () => {
    const order = await makeOrder({ paymentMethod: "cash_on_delivery" });
    const { cookie, adminId } = await seedAdminSession();
    const res = await postStatus(
      order.orderNumber,
      {
        status: "shipped",
        expectedVersion: 1,
        courierCompany: "Еконт",
        trackingNumber: "1054321000",
        note: "Предадена на куриер в 14:00",
      },
      cookie,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      version: number;
      courierCompany: string | null;
      trackingNumber: string | null;
      statusHistory: {
        status: string;
        changedByUserId: string | null;
        changedByEmail: string | null;
        note: string | null;
      }[];
      allowedTargets: string[];
    };
    expect(body.status).toBe("shipped");
    expect(body.version).toBe(2);
    expect(body.courierCompany).toBe("Еконт");
    expect(body.trackingNumber).toBe("1054321000");
    expect(body.allowedTargets).toEqual(["delivered"]);
    expect(body.statusHistory).toHaveLength(2);
    const audit = body.statusHistory[1]!;
    expect(audit.status).toBe("shipped");
    expect(audit.changedByUserId).toBe(adminId);
    expect(audit.changedByEmail).toBe("admin@shop.bg");
    expect(audit.note).toBe("Предадена на куриер в 14:00");

    const stub = getStubTransportForTests();
    const mails = stub.sent.filter(
      (e) => e.templateId === ORDER_STATUS_UPDATE_TEMPLATE_ID,
    );
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toBe("kupuvach@example.com");
    expect(mails[0]!.subject).toContain(order.orderNumber);
    expect(mails[0]!.text).toContain("1054321000");
    expect(mails[0]!.text).toContain("Еконт");
  });

  it("rejects shipped without courier fields (400, field errors, no change, no email)", async () => {
    const order = await makeOrder({ paymentMethod: "cash_on_delivery" });
    const { cookie } = await seedAdminSession();
    const res = await postStatus(
      order.orderNumber,
      { status: "shipped", expectedVersion: 1 },
      cookie,
    );
    expect(res.status).toBe(400);
    const problem = (await res.json()) as {
      errors?: { path: string }[];
    };
    expect(problem.errors?.map((e) => e.path).sort()).toEqual([
      "courierCompany",
      "trackingNumber",
    ]);
    const db = getDb();
    const [row] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, order.id));
    expect(row!.status).toBe("processing");
    expect(row!.version).toBe(1);
    expect(getStubTransportForTests().sent).toHaveLength(0);
  });

  it("rejects companion fields that do not belong to the target", async () => {
    const order = await makeOrder({ paymentMethod: "cash_on_delivery" });
    const { cookie } = await seedAdminSession();
    const res = await postStatus(
      order.orderNumber,
      {
        status: "cancelled",
        expectedVersion: 1,
        courierCompany: "Еконт",
      },
      cookie,
    );
    expect(res.status).toBe(400);
    const problem = (await res.json()) as { errors?: { path: string }[] };
    expect(problem.errors?.[0]?.path).toBe("courierCompany");
  });

  it("409s on a payment-method-illegal hop (shipped on a pay_at_store order)", async () => {
    const order = await makeOrder({ paymentMethod: "pay_at_store" });
    const { cookie } = await seedAdminSession();
    const res = await postStatus(
      order.orderNumber,
      {
        status: "shipped",
        expectedVersion: 1,
        courierCompany: "Еконт",
        trackingNumber: "123",
      },
      cookie,
    );
    expect(res.status).toBe(409);
    const problem = (await res.json()) as { type: string; detail?: string };
    expect(problem.type).toBe("/problems/invalid-status-transition");
    expect(problem.detail).toContain("ready_for_pickup");
  });

  it("processing → ready_for_pickup requires a FUTURE pickupDeadline and emails it", async () => {
    const order = await makeOrder({ paymentMethod: "pay_at_store" });
    const { cookie } = await seedAdminSession();

    const past = await postStatus(
      order.orderNumber,
      {
        status: "ready_for_pickup",
        expectedVersion: 1,
        pickupDeadline: "2020-01-01T10:00:00.000Z",
      },
      cookie,
    );
    expect(past.status).toBe(400);

    const deadline = new Date(Date.now() + 3 * 24 * 3600 * 1000);
    const res = await postStatus(
      order.orderNumber,
      {
        status: "ready_for_pickup",
        expectedVersion: 1,
        pickupDeadline: deadline.toISOString(),
      },
      cookie,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      pickupDeadline: string | null;
      allowedTargets: string[];
    };
    expect(body.status).toBe("ready_for_pickup");
    expect(body.pickupDeadline).toBe(deadline.toISOString());
    expect(body.allowedTargets.sort()).toEqual(["accepted", "cancelled"]);
    const mails = getStubTransportForTests().sent.filter(
      (e) => e.templateId === ORDER_STATUS_UPDATE_TEMPLATE_ID,
    );
    expect(mails).toHaveLength(1);
  });

  it("processing → cancelled carries the optional reason into the email", async () => {
    const order = await makeOrder({ paymentMethod: "cash_on_delivery" });
    const { cookie } = await seedAdminSession();
    const res = await postStatus(
      order.orderNumber,
      {
        status: "cancelled",
        expectedVersion: 1,
        cancelledReason: "Продуктът е изчерпан",
      },
      cookie,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      cancelledReason: string | null;
      allowedTargets: string[];
    };
    expect(body.status).toBe("cancelled");
    expect(body.cancelledReason).toBe("Продуктът е изчерпан");
    expect(body.allowedTargets).toEqual([]); // terminal
    const mails = getStubTransportForTests().sent.filter(
      (e) => e.templateId === ORDER_STATUS_UPDATE_TEMPLATE_ID,
    );
    expect(mails).toHaveLength(1);
    expect(mails[0]!.text).toContain("Продуктът е изчерпан");
  });

  it("walks the full COD happy path: shipped → delivered → accepted (sets acceptedAt)", async () => {
    const order = await makeOrder({
      paymentMethod: "cash_on_delivery",
      status: "shipped",
    });
    const { cookie } = await seedAdminSession();

    const delivered = await postStatus(
      order.orderNumber,
      { status: "delivered", expectedVersion: 1 },
      cookie,
    );
    expect(delivered.status).toBe(200);

    const accepted = await postStatus(
      order.orderNumber,
      { status: "accepted", expectedVersion: 2 },
      cookie,
    );
    expect(accepted.status).toBe(200);
    const body = (await accepted.json()) as {
      status: string;
      acceptedAt: string | null;
      version: number;
    };
    expect(body.status).toBe("accepted");
    expect(body.version).toBe(3);
    expect(body.acceptedAt).not.toBeNull();
    // Both transitions are customer-visible → two emails.
    const mails = getStubTransportForTests().sent.filter(
      (e) => e.templateId === ORDER_STATUS_UPDATE_TEMPLATE_ID,
    );
    expect(mails).toHaveLength(2);
  });

  it("ready_for_pickup → accepted sets acceptedAt (pickup taken)", async () => {
    const order = await makeOrder({
      paymentMethod: "pay_at_store",
      status: "ready_for_pickup",
    });
    const { cookie } = await seedAdminSession();
    const res = await postStatus(
      order.orderNumber,
      { status: "accepted", expectedVersion: 1 },
      cookie,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { acceptedAt: string | null };
    expect(body.acceptedAt).not.toBeNull();
  });

  it("delivered → returned succeeds but sends NO email (internal bookkeeping)", async () => {
    const order = await makeOrder({
      paymentMethod: "cash_on_delivery",
      status: "delivered",
    });
    const { cookie } = await seedAdminSession();
    const res = await postStatus(
      order.orderNumber,
      { status: "returned", expectedVersion: 1 },
      cookie,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; allowedTargets: string[] };
    expect(body.status).toBe("returned");
    expect(body.allowedTargets).toEqual([]);
    expect(getStubTransportForTests().sent).toHaveLength(0);
  });

  it("409s out of terminal statuses (accepted, cancelled)", async () => {
    const { cookie } = await seedAdminSession();
    for (const status of ["accepted", "cancelled"] as const) {
      const order = await makeOrder({ status });
      const res = await postStatus(
        order.orderNumber,
        { status: "delivered", expectedVersion: 1 },
        cookie,
      );
      expect(res.status).toBe(409);
      const problem = (await res.json()) as { type: string; detail?: string };
      expect(problem.type).toBe("/problems/invalid-status-transition");
      expect(problem.detail).toContain("terminal");
    }
  });

  it("409s with /problems/order-version-conflict on a stale expectedVersion — nothing changes", async () => {
    const order = await makeOrder({ paymentMethod: "cash_on_delivery" });
    const { cookie } = await seedAdminSession();
    // Tab A ships the order (version 1 → 2)…
    const first = await postStatus(
      order.orderNumber,
      {
        status: "shipped",
        expectedVersion: 1,
        courierCompany: "Спиди",
        trackingNumber: "555",
      },
      cookie,
    );
    expect(first.status).toBe(200);
    // …Tab B still shows version 1 and tries to cancel.
    const stale = await postStatus(
      order.orderNumber,
      { status: "cancelled", expectedVersion: 1 },
      cookie,
    );
    expect(stale.status).toBe(409);
    const problem = (await stale.json()) as { type: string; detail?: string };
    expect(problem.type).toBe("/problems/order-version-conflict");
    expect(problem.detail).toContain("version 2");

    const db = getDb();
    const [row] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, order.id));
    expect(row!.status).toBe("shipped"); // tab B's cancel did NOT land
    expect(row!.version).toBe(2);
    const history = await db
      .select()
      .from(schema.orderStatusHistory)
      .where(eq(schema.orderStatusHistory.orderId, order.id));
    expect(history).toHaveLength(2); // seed + shipped only — no cancelled entry
    // Exactly one email (the shipped one) — the failed cancel sent nothing.
    const mails = getStubTransportForTests().sent.filter(
      (e) => e.templateId === ORDER_STATUS_UPDATE_TEMPLATE_ID,
    );
    expect(mails).toHaveLength(1);
  });

  it("a transport failure does NOT fail the transition (best-effort email)", async () => {
    const failing: EmailTransport = {
      send: () => Promise.reject(new Error("SES down")),
    };
    setEmailTransportForTests(failing);
    const order = await makeOrder({ paymentMethod: "cash_on_delivery" });
    const { cookie } = await seedAdminSession();
    const res = await postStatus(
      order.orderNumber,
      { status: "cancelled", expectedVersion: 1 },
      cookie,
    );
    expect(res.status).toBe(200);
    const db = getDb();
    const [row] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, order.id));
    expect(row!.status).toBe("cancelled");
  });

  it("404s with /problems/order-not-found for an unknown order", async () => {
    const { cookie } = await seedAdminSession();
    const res = await postStatus(
      "2099-01-77777",
      { status: "cancelled", expectedVersion: 1 },
      cookie,
    );
    expect(res.status).toBe(404);
    const problem = (await res.json()) as { type: string };
    expect(problem.type).toBe("/problems/order-not-found");
  });
});

// ─── GET /admin/orders/export.csv ────────────────────────────────────────────

describe("GET /admin/orders/export.csv", () => {
  it("returns BOM-prefixed UTF-8 CSV honouring the active filters", async () => {
    await makeOrder({ status: "processing" });
    const shipped = await makeOrder({
      status: "shipped",
      withDelivery: true,
      items: [{ code: "X-9", name: "Шлайф", unitPriceCents: 9_900, quantity: 2 }],
    });
    const { cookie } = await seedAdminSession();
    const res = await get("/admin/orders/export.csv?status=shipped", cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("orders-export-");
    // BOM check on the RAW BYTES: WHATWG `Response.text()` (and TextDecoder
    // with default options) strips a leading U+FEFF during UTF-8 decode, so
    // the decoded string can never show it — Excel, however, reads the bytes.
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder("utf-8").decode(bytes); // strips the BOM
    const lines = text.trimEnd().split("\r\n");
    expect(lines).toHaveLength(2); // header + the one shipped order
    expect(lines[0]).toContain("Номер");
    expect(lines[1]).toContain(shipped.orderNumber);
    expect(lines[1]).toContain("Изпратена");
    expect(lines[1]).toContain("X-9 × 2 Шлайф @ 99.00");
    expect(lines[1]).toContain("1000 София");
  });

  it("neutralises formula-injection payloads in customer-controlled fields", async () => {
    await makeOrder({
      customerName: "=HYPERLINK(\"https://evil.example\",\"click\")",
      customerEmail: "plus@example.com",
    });
    const { cookie } = await seedAdminSession();
    const text = await (await get("/admin/orders/export.csv", cookie)).text();
    // The dangerous leading "=" must be TAB-prefixed inside its quoted cell.
    expect(text).toContain('"\t=HYPERLINK(""https://evil.example"",""click"")"');
    expect(text).not.toContain(',"=HYPERLINK');
  });
});
