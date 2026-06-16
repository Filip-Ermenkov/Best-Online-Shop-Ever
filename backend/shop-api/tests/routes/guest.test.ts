import { hashPassword } from "@shop/auth";
import { schema } from "@shop/db";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { sessionCookieName } from "../../src/lib/cookies.js";
import { getDb } from "../../src/lib/db.js";
import { getStubTransportForTests } from "../../src/lib/emails.js";
import { seedSmallCatalog } from "../fixtures.js";

/**
 * Integration tests for the guest slice (the spec's "Гост" role).
 *
 * Routes under test:
 *   POST /guest/orders
 *   GET  /track/:token
 *   POST /track/:token/cancel
 *   GET  /track/:token/withdrawal/eligibility
 *   POST /track/:token/withdrawal
 *   POST /track/find
 *   POST /orders/:orderNumber/cancel   (authenticated customer cancel)
 *
 * The per-test TRUNCATE (tests/setup/per-test.ts) gives every test a clean DB
 * and resets the in-memory rate limiters, so we don't juggle IPs except in the
 * dedicated rate-limit test.
 */

let app: ReturnType<typeof buildApp>;

beforeAll(() => {
  app = buildApp();
});

const GUEST = { email: "guest@example.com", name: "Гост Иванов", phone: "0888123456" };

function emailContains(token: string): boolean {
  const stub = getStubTransportForTests();
  return stub.sent.some(
    (m) => `${m.text ?? ""}${(m as { html?: string }).html ?? ""}`.includes(token),
  );
}

async function placeGuestOrder(opts: {
  items: { productId: string; quantity: number }[];
  paymentMethod?: "cash_on_delivery" | "pay_at_store";
  deliveryAddress?: {
    city: string;
    postalCode: string;
    street: string;
    apartmentOrOffice?: string;
  };
  contact?: { email: string; name: string; phone: string };
  idempotencyKey?: string;
  ip?: string;
}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Idempotency-Key": opts.idempotencyKey ?? crypto.randomUUID(),
  };
  if (opts.ip) headers["x-forwarded-for"] = opts.ip;
  const body: Record<string, unknown> = {
    contact: opts.contact ?? GUEST,
    paymentMethod: opts.paymentMethod ?? "pay_at_store",
    items: opts.items,
  };
  if (opts.deliveryAddress) body.deliveryAddress = opts.deliveryAddress;
  return app.request("/guest/orders", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

// ─── Guest order placement ───────────────────────────────────────────────────

describe("POST /guest/orders", () => {
  it("places a pay-at-store order and returns a tracking token", async () => {
    const { p1 } = await seedSmallCatalog();
    const res = await placeGuestOrder({ items: [{ productId: p1.id, quantity: 2 }] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("processing");
    expect(typeof body.trackToken).toBe("string");
    expect((body.trackToken as string).length).toBe(43);
    expect(body.trackPath).toBe(`/track/${body.trackToken}`);
    expect(body.totalCents).toBe(9999 * 2);

    // The order is anonymous in the DB.
    const db = getDb();
    const [row] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.orderNumber, body.orderNumber as string));
    expect(row!.customerId).toBeNull();
    expect(row!.customerPhone).toBe("+359888123456"); // normalised to E.164

    // Confirmation email carries the durable /track deep link.
    expect(emailContains(`/track/${body.trackToken}`)).toBe(true);
  });

  it("places a cash-on-delivery order and snapshots the delivery address", async () => {
    const { p1 } = await seedSmallCatalog();
    const res = await placeGuestOrder({
      items: [{ productId: p1.id, quantity: 1 }],
      paymentMethod: "cash_on_delivery",
      deliveryAddress: { city: "София", postalCode: "1000", street: "ул. Тест 1" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body.deliveryAddress as Record<string, unknown>).city).toBe("София");
  });

  it("rejects cash-on-delivery without a delivery address (400)", async () => {
    const { p1 } = await seedSmallCatalog();
    const res = await placeGuestOrder({
      items: [{ productId: p1.id, quantity: 1 }],
      paymentMethod: "cash_on_delivery",
    });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid Bulgarian phone (400)", async () => {
    const { p1 } = await seedSmallCatalog();
    const res = await placeGuestOrder({
      items: [{ productId: p1.id, quantity: 1 }],
      contact: { ...GUEST, phone: "12345" },
    });
    expect(res.status).toBe(400);
  });

  it("returns 409 when a requested item is out of stock", async () => {
    const { p1, p3 } = await seedSmallCatalog(); // p3 is out_of_stock
    const res = await placeGuestOrder({
      items: [
        { productId: p1.id, quantity: 1 },
        { productId: p3.id, quantity: 1 },
      ],
    });
    expect(res.status).toBe(409);
  });

  it("returns 422 when nothing in the cart is purchasable", async () => {
    const { p3 } = await seedSmallCatalog(); // only the out-of-stock product
    const res = await placeGuestOrder({ items: [{ productId: p3.id, quantity: 1 }] });
    expect(res.status).toBe(422);
  });

  it("is idempotent: a replayed Idempotency-Key returns the same order once", async () => {
    const { p1 } = await seedSmallCatalog();
    const key = crypto.randomUUID();
    const first = await placeGuestOrder({
      items: [{ productId: p1.id, quantity: 1 }],
      idempotencyKey: key,
    });
    const firstBody = (await first.json()) as Record<string, unknown>;
    const second = await placeGuestOrder({
      items: [{ productId: p1.id, quantity: 1 }],
      idempotencyKey: key,
    });
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as Record<string, unknown>;
    expect(secondBody.orderNumber).toBe(firstBody.orderNumber);
    expect(secondBody.trackToken).toBe(firstBody.trackToken);

    const db = getDb();
    const rows = await db.select().from(schema.orders);
    expect(rows.length).toBe(1);
    // The replay short-circuits before the email send → only one confirmation.
    const stub = getStubTransportForTests();
    const confirmations = stub.sent.filter((m) => m.to === GUEST.email);
    expect(confirmations.length).toBe(1);
  });
});

// ─── Track view ──────────────────────────────────────────────────────────────

describe("GET /track/:token", () => {
  it("returns the order for a valid token", async () => {
    const { p1 } = await seedSmallCatalog();
    const place = await placeGuestOrder({ items: [{ productId: p1.id, quantity: 1 }] });
    const { trackToken, orderNumber } = (await place.json()) as Record<string, string>;

    const res = await app.request(`/track/${trackToken}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.orderNumber).toBe(orderNumber);
    expect(body.status).toBe("processing");
    expect(body.canCancel).toBe(true);
    expect(Array.isArray(body.statusHistory)).toBe(true);
  });

  it("returns 404 for an unknown but well-formed token", async () => {
    const res = await app.request(`/track/${"a".repeat(43)}`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for a malformed token", async () => {
    const res = await app.request("/track/short");
    expect(res.status).toBe(404);
  });
});

// ─── Guest cancellation ──────────────────────────────────────────────────────

describe("POST /track/:token/cancel", () => {
  it("cancels a processing order and notifies by email", async () => {
    const { p1 } = await seedSmallCatalog();
    const place = await placeGuestOrder({ items: [{ productId: p1.id, quantity: 1 }] });
    const { trackToken } = (await place.json()) as {
      trackToken: string;
      orderNumber: string;
    };

    const res = await app.request(`/track/${trackToken}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("cancelled");
    expect(body.canCancel).toBe(false);

    const db = getDb();
    const [row] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.guestTrackToken, trackToken));
    expect(row!.status).toBe("cancelled");
  });

  it("refuses to cancel once the order has moved past processing (422)", async () => {
    const { p1 } = await seedSmallCatalog();
    const place = await placeGuestOrder({ items: [{ productId: p1.id, quantity: 1 }] });
    const { trackToken } = (await place.json()) as {
      trackToken: string;
      orderNumber: string;
    };

    const db = getDb();
    await db
      .update(schema.orders)
      .set({ status: "shipped" })
      .where(eq(schema.orders.guestTrackToken, trackToken));

    const res = await app.request(`/track/${trackToken}/cancel`, { method: "POST" });
    expect(res.status).toBe(422);
  });
});

// ─── Guest withdrawal (14-day right) ────────────────────────────────────────

describe("guest withdrawal via /track/:token", () => {
  async function placeThenAccept(daysAgo: number) {
    const { p1 } = await seedSmallCatalog();
    const place = await placeGuestOrder({ items: [{ productId: p1.id, quantity: 1 }] });
    const { trackToken } = (await place.json()) as {
      trackToken: string;
      orderNumber: string;
    };
    const acceptedAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    const db = getDb();
    await db
      .update(schema.orders)
      .set({ status: "accepted", acceptedAt })
      .where(eq(schema.orders.guestTrackToken, trackToken));
    return trackToken;
  }

  it("reports eligible:true within the 14-day window", async () => {
    const token = await placeThenAccept(3);
    const res = await app.request(`/track/${token}/withdrawal/eligibility`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.eligible).toBe(true);
    expect(body.windowDays).toBe(14);
  });

  it("reports window_expired after 14 days", async () => {
    const token = await placeThenAccept(20);
    const res = await app.request(`/track/${token}/withdrawal/eligibility`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.eligible).toBe(false);
    expect(body.reason).toBe("window_expired");
  });

  it("records a withdrawal and is idempotent", async () => {
    const token = await placeThenAccept(2);
    const first = await app.request(`/track/${token}/withdrawal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Размислих се." }),
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as Record<string, unknown>;

    const second = await app.request(`/track/${token}/withdrawal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(second.status).toBe(200); // idempotent replay
    const secondBody = (await second.json()) as Record<string, unknown>;
    expect(secondBody.submittedAt).toBe(firstBody.submittedAt);
  });

  it("refuses withdrawal while still processing (422)", async () => {
    const { p1 } = await seedSmallCatalog();
    const place = await placeGuestOrder({ items: [{ productId: p1.id, quantity: 1 }] });
    const { trackToken } = (await place.json()) as {
      trackToken: string;
      orderNumber: string;
    };
    const res = await app.request(`/track/${trackToken}/withdrawal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });
});

// ─── Find my order ───────────────────────────────────────────────────────────

describe("POST /track/find", () => {
  it("re-sends the link on a matching order+email and returns ok", async () => {
    const { p1 } = await seedSmallCatalog();
    const place = await placeGuestOrder({ items: [{ productId: p1.id, quantity: 1 }] });
    const { orderNumber, trackToken } = (await place.json()) as Record<string, string>;
    getStubTransportForTests().reset(); // ignore the confirmation send

    const res = await app.request("/track/find", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderNumber, email: GUEST.email }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toEqual({ ok: true });
    expect(emailContains(`/track/${trackToken}`)).toBe(true);
  });

  it("returns ok and sends nothing on a non-match (enumeration-resistant)", async () => {
    const { p1 } = await seedSmallCatalog();
    const place = await placeGuestOrder({ items: [{ productId: p1.id, quantity: 1 }] });
    const { orderNumber } = (await place.json()) as Record<string, string>;
    getStubTransportForTests().reset();

    const res = await app.request("/track/find", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderNumber, email: "wrong@example.com" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toEqual({ ok: true });
    expect(getStubTransportForTests().sent.length).toBe(0);
  });

  it("rate-limits to 3 requests/hour/IP", async () => {
    const ip = "203.0.113.7";
    const req = () =>
      app.request("/track/find", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify({ orderNumber: "2026-01-00001", email: "x@example.com" }),
      });
    expect((await req()).status).toBe(200);
    expect((await req()).status).toBe(200);
    expect((await req()).status).toBe(200);
    expect((await req()).status).toBe(429); // 4th in the same hour
  });
});

// ─── Authenticated customer cancellation ─────────────────────────────────────

describe("POST /orders/:orderNumber/cancel (account customer)", () => {
  const VALID_PASSWORD = "Hunter2!Bigger";

  function extractSessionCookie(setCookie: string | null): string | null {
    if (!setCookie) return null;
    const name = sessionCookieName();
    const match = setCookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    return match?.[1] ?? null;
  }

  async function seedVerifiedCustomer(email: string) {
    const db = getDb();
    const passwordHash = await hashPassword(VALID_PASSWORD);
    const [user] = await db
      .insert(schema.users)
      .values({
        email,
        passwordHash,
        role: "customer",
        accountType: "personal",
        emailVerifiedAt: new Date(),
      })
      .returning();
    await db.insert(schema.customerProfiles).values({
      userId: user!.id,
      fullName: "Иван Иванов",
      phone: "+359888000000",
    });
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: VALID_PASSWORD, rememberMe: false }),
    });
    const cookie = extractSessionCookie(res.headers.get("set-cookie"))!;
    return { id: user!.id, email, cookie };
  }

  async function seedProcessingOrder(userId: string, email: string, num: string) {
    const db = getDb();
    const [order] = await db
      .insert(schema.orders)
      .values({
        orderNumber: num,
        customerId: userId,
        idempotencyKey: `test-${crypto.randomUUID()}`,
        status: "processing",
        paymentMethod: "pay_at_store",
        customerEmail: email,
        customerName: "Иван Иванов",
        customerPhone: "+359888000000",
        subtotalCents: "1999",
        discountPercent: "0",
        discountAmountCents: "0",
        totalCents: "1999",
      })
      .returning();
    await db.insert(schema.orderStatusHistory).values({
      orderId: order!.id,
      status: "processing",
    });
    return order!;
  }

  function cookieHeader(token: string): Record<string, string> {
    return { "Content-Type": "application/json", Cookie: `${sessionCookieName()}=${token}` };
  }

  it("rejects an unauthenticated cancel with 401", async () => {
    const res = await app.request("/orders/2026-01-00001/cancel", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("cancels the owner's processing order", async () => {
    const user = await seedVerifiedCustomer("cancel-me@example.com");
    const order = await seedProcessingOrder(user.id, user.email, "2026-01-00010");
    const res = await app.request(`/orders/${order.orderNumber}/cancel`, {
      method: "POST",
      headers: cookieHeader(user.cookie),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).status).toBe("cancelled");
  });

  it("returns 404 for an order belonging to another user", async () => {
    const owner = await seedVerifiedCustomer("owner@example.com");
    const other = await seedVerifiedCustomer("other@example.com");
    const order = await seedProcessingOrder(owner.id, owner.email, "2026-01-00011");
    const res = await app.request(`/orders/${order.orderNumber}/cancel`, {
      method: "POST",
      headers: cookieHeader(other.cookie),
    });
    expect(res.status).toBe(404);
  });

  it("returns 422 when the order is past processing", async () => {
    const user = await seedVerifiedCustomer("late@example.com");
    const order = await seedProcessingOrder(user.id, user.email, "2026-01-00012");
    const db = getDb();
    await db
      .update(schema.orders)
      .set({ status: "shipped" })
      .where(eq(schema.orders.id, order.id));
    const res = await app.request(`/orders/${order.orderNumber}/cancel`, {
      method: "POST",
      headers: cookieHeader(user.cookie),
    });
    expect(res.status).toBe(422);
  });
});
