import { hashPassword } from "@shop/auth";
import { schema } from "@shop/db";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { sessionCookieName } from "../../src/lib/cookies.js";
import { getDb } from "../../src/lib/db.js";
import { getStubTransportForTests } from "../../src/lib/emails.js";

/**
 * Integration tests for the 14-day right-of-withdrawal slice.
 *
 * Routes under test:
 *   - GET  /orders/:orderNumber/withdrawal/eligibility
 *   - GET  /orders/:orderNumber/withdrawal
 *   - POST /orders/:orderNumber/withdrawal
 *
 * Schema fixtures: orders inserted directly into `accepted` state so we don't
 * have to drive the full place-order → admin-accept pipeline (the latter
 * doesn't exist yet — that's the admin-api slice).
 */

let app: ReturnType<typeof buildApp>;

beforeAll(() => {
  app = buildApp();
});

const VALID_PASSWORD = "Hunter2!Bigger";

function extractSessionCookie(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const name = sessionCookieName();
  const match = setCookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match?.[1] ?? null;
}

function cookieHeader(token: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Cookie: `${sessionCookieName()}=${token}`,
  };
}

async function seedVerifiedCustomer(opts?: {
  email?: string;
  fullName?: string;
  phone?: string;
}): Promise<{ id: string; email: string; cookie: string }> {
  const db = getDb();
  const email = (opts?.email ?? "buyer@example.com").toLowerCase();
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
  if (!user) throw new Error("user seed failed");
  await db.insert(schema.customerProfiles).values({
    userId: user.id,
    fullName: opts?.fullName ?? "Иван Иванов",
    phone: opts?.phone ?? "+359888000000",
  });

  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: VALID_PASSWORD, rememberMe: false }),
  });
  if (res.status !== 200) {
    throw new Error(`login failed in test setup: ${res.status}`);
  }
  const token = extractSessionCookie(res.headers.get("set-cookie"));
  if (!token) throw new Error("no session cookie returned");
  return { id: user.id, email, cookie: token };
}

/**
 * Insert an order directly with `status='accepted'` and a controllable
 * `accepted_at`. Bypasses the placeOrder route because the admin transition
 * to `accepted` does not exist yet (admin-api slice). Seeds the minimum
 * necessary side rows (status history) so the row is consistent.
 */
async function seedAcceptedOrder(opts: {
  userId: string;
  customerEmail: string;
  acceptedDaysAgo?: number;
  orderNumber?: string;
}): Promise<{ id: string; orderNumber: string; acceptedAt: Date }> {
  const db = getDb();
  const acceptedAt = new Date(
    Date.now() - (opts.acceptedDaysAgo ?? 0) * 24 * 60 * 60 * 1000,
  );
  const orderNumber =
    opts.orderNumber ?? `2026-05-${String(Math.floor(Math.random() * 99999)).padStart(5, "0")}`;
  const [order] = await db
    .insert(schema.orders)
    .values({
      orderNumber,
      customerId: opts.userId,
      idempotencyKey: `test-${crypto.randomUUID()}`,
      status: "accepted",
      paymentMethod: "pay_at_store",
      customerEmail: opts.customerEmail,
      customerPhone: "+359888000000",
      customerName: "Иван Иванов",
      subtotalCents: "1999",
      discountPercent: "0",
      discountAmountCents: "0",
      totalCents: "1999",
      acceptedAt,
    })
    .returning();
  if (!order) throw new Error("order seed failed");
  await db.insert(schema.orderStatusHistory).values([
    { orderId: order.id, status: "processing" },
    { orderId: order.id, status: "ready_for_pickup" },
    { orderId: order.id, status: "accepted", changedAt: acceptedAt },
  ]);
  return { id: order.id, orderNumber: order.orderNumber, acceptedAt };
}

// ─── Auth gate ─────────────────────────────────────────────────────────────

describe("Withdrawal — auth gate", () => {
  it("rejects unauthenticated GET eligibility with 401", async () => {
    const res = await app.request("/orders/2026-05-00001/withdrawal/eligibility", {
      method: "GET",
    });
    expect(res.status).toBe(401);
  });
  it("rejects unauthenticated POST with 401", async () => {
    const res = await app.request("/orders/2026-05-00001/withdrawal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });
  it("rejects unauthenticated GET with 401", async () => {
    const res = await app.request("/orders/2026-05-00001/withdrawal", {
      method: "GET",
    });
    expect(res.status).toBe(401);
  });
});

// ─── Eligibility ───────────────────────────────────────────────────────────

describe("GET /orders/:orderNumber/withdrawal/eligibility", () => {
  it("returns eligible:true with deadline for a fresh accepted order", async () => {
    const user = await seedVerifiedCustomer({ email: "elig1@example.com" });
    const order = await seedAcceptedOrder({
      userId: user.id,
      customerEmail: user.email,
      acceptedDaysAgo: 2,
    });

    const res = await app.request(
      `/orders/${order.orderNumber}/withdrawal/eligibility`,
      { method: "GET", headers: cookieHeader(user.cookie) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.eligible).toBe(true);
    expect(body.windowDays).toBe(14);
    expect(typeof body.deadlineAt).toBe("string");
    expect(body.alreadySubmittedAt).toBeNull();
  });

  it("returns 404 for an order belonging to another user", async () => {
    const userA = await seedVerifiedCustomer({ email: "elig-a@example.com" });
    const userB = await seedVerifiedCustomer({ email: "elig-b@example.com" });
    const order = await seedAcceptedOrder({
      userId: userB.id,
      customerEmail: userB.email,
    });

    const res = await app.request(
      `/orders/${order.orderNumber}/withdrawal/eligibility`,
      { method: "GET", headers: cookieHeader(userA.cookie) },
    );
    expect(res.status).toBe(404);
  });

  it("returns eligible:false reason=window_expired for >14-day-old order", async () => {
    const user = await seedVerifiedCustomer({ email: "elig-old@example.com" });
    const order = await seedAcceptedOrder({
      userId: user.id,
      customerEmail: user.email,
      acceptedDaysAgo: 20,
    });

    const res = await app.request(
      `/orders/${order.orderNumber}/withdrawal/eligibility`,
      { method: "GET", headers: cookieHeader(user.cookie) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.eligible).toBe(false);
    expect(body.reason).toBe("window_expired");
  });

  it("returns eligible:false reason=not_accepted for an order still processing", async () => {
    const user = await seedVerifiedCustomer({ email: "elig-proc@example.com" });
    const db = getDb();
    // Insert an order in processing (no accepted_at).
    const orderNumber = `2026-05-${String(Math.floor(Math.random() * 99999)).padStart(5, "0")}`;
    const [order] = await db
      .insert(schema.orders)
      .values({
        orderNumber,
        customerId: user.id,
        idempotencyKey: `test-${crypto.randomUUID()}`,
        status: "processing",
        paymentMethod: "pay_at_store",
        customerEmail: user.email,
        customerPhone: "+359888000000",
        customerName: "Иван",
        subtotalCents: "1000",
        discountPercent: "0",
        discountAmountCents: "0",
        totalCents: "1000",
      })
      .returning();

    const res = await app.request(
      `/orders/${order!.orderNumber}/withdrawal/eligibility`,
      { method: "GET", headers: cookieHeader(user.cookie) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.eligible).toBe(false);
    expect(body.reason).toBe("not_accepted");
  });
});

// ─── POST happy path ───────────────────────────────────────────────────────

describe("POST /orders/:orderNumber/withdrawal — happy path", () => {
  it("records the withdrawal, persists the customer snapshot, returns 201", async () => {
    const user = await seedVerifiedCustomer({ email: "post1@example.com" });
    const order = await seedAcceptedOrder({
      userId: user.id,
      customerEmail: user.email,
      acceptedDaysAgo: 1,
    });

    const res = await app.request(
      `/orders/${order.orderNumber}/withdrawal`,
      {
        method: "POST",
        headers: cookieHeader(user.cookie),
        body: JSON.stringify({ reason: "Размерът не ми пасва." }),
      },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      orderNumber: string;
      reason: string | null;
      submittedAt: string;
      acknowledgedAt: string | null;
      customerEmail: string;
      customerName: string;
      customerPhone: string;
    };
    expect(body.orderNumber).toBe(order.orderNumber);
    expect(body.reason).toBe("Размерът не ми пасва.");
    expect(body.customerEmail).toBe(user.email);
    expect(typeof body.submittedAt).toBe("string");

    // Row exists in the DB with the right shape.
    const db = getDb();
    const [row] = await db
      .select()
      .from(schema.complaints)
      .where(
        and(
          eq(schema.complaints.orderId, order.id),
          eq(schema.complaints.reason, "withdrawal"),
        ),
      );
    expect(row).toBeTruthy();
    expect(row!.customerEmail).toBe(user.email);
    expect(row!.description).toBe("Размерът не ми пасва.");
  });

  it("sends a customer acknowledgement email with a date+time stamp", async () => {
    const user = await seedVerifiedCustomer({ email: "post-ack@example.com" });
    const order = await seedAcceptedOrder({
      userId: user.id,
      customerEmail: user.email,
    });

    const res = await app.request(
      `/orders/${order.orderNumber}/withdrawal`,
      {
        method: "POST",
        headers: cookieHeader(user.cookie),
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(201);

    const stub = getStubTransportForTests();
    const ack = stub.findLast(
      (e) => e.templateId === "orders.withdrawal-received",
    );
    expect(ack).toBeTruthy();
    expect(ack!.to).toBe(user.email);
    // Art. 11a(2): explicit date/time of receipt on a durable medium.
    expect(ack!.text).toContain(order.orderNumber);
    expect(ack!.text).toContain("Европа/София");
    // Includes the legal-basis cue so the customer knows the email is the
    // receipt for their right of withdrawal.
    expect(ack!.text).toContain("чл. 50");
  });

  it("sends an admin notification email with the customer contact", async () => {
    const user = await seedVerifiedCustomer({ email: "post-admin@example.com" });
    const order = await seedAcceptedOrder({
      userId: user.id,
      customerEmail: user.email,
    });

    await app.request(`/orders/${order.orderNumber}/withdrawal`, {
      method: "POST",
      headers: cookieHeader(user.cookie),
      body: JSON.stringify({ reason: "Не ми харесва." }),
    });

    const stub = getStubTransportForTests();
    const admin = stub.findLast(
      (e) => e.templateId === "orders.withdrawal-admin-notification",
    );
    expect(admin).toBeTruthy();
    expect(admin!.text).toContain(order.orderNumber);
    expect(admin!.text).toContain(user.email);
    expect(admin!.text).toContain("Не ми харесва.");
  });

  it("sets acknowledged_at to a timestamp after a successful send", async () => {
    const user = await seedVerifiedCustomer({ email: "post-ackset@example.com" });
    const order = await seedAcceptedOrder({
      userId: user.id,
      customerEmail: user.email,
    });
    await app.request(`/orders/${order.orderNumber}/withdrawal`, {
      method: "POST",
      headers: cookieHeader(user.cookie),
      body: JSON.stringify({}),
    });
    const db = getDb();
    const [row] = await db
      .select()
      .from(schema.complaints)
      .where(eq(schema.complaints.orderId, order.id));
    expect(row).toBeTruthy();
    expect(row!.acknowledgedAt).toBeTruthy();
  });

  it("works with no body at all (empty POST is valid — reason is optional)", async () => {
    const user = await seedVerifiedCustomer({ email: "post-empty@example.com" });
    const order = await seedAcceptedOrder({
      userId: user.id,
      customerEmail: user.email,
    });
    const res = await app.request(`/orders/${order.orderNumber}/withdrawal`, {
      method: "POST",
      headers: {
        Cookie: `${sessionCookieName()}=${user.cookie}`,
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { reason: string | null };
    expect(body.reason).toBeNull();
  });
});

// ─── POST idempotency ──────────────────────────────────────────────────────

describe("POST /orders/:orderNumber/withdrawal — idempotency", () => {
  it("returns 200 with the SAME record on the second submission", async () => {
    const user = await seedVerifiedCustomer({ email: "idem@example.com" });
    const order = await seedAcceptedOrder({
      userId: user.id,
      customerEmail: user.email,
    });

    const first = await app.request(
      `/orders/${order.orderNumber}/withdrawal`,
      {
        method: "POST",
        headers: cookieHeader(user.cookie),
        body: JSON.stringify({ reason: "first" }),
      },
    );
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { id: string; submittedAt: string };

    const second = await app.request(
      `/orders/${order.orderNumber}/withdrawal`,
      {
        method: "POST",
        headers: cookieHeader(user.cookie),
        body: JSON.stringify({ reason: "second — but should be ignored" }),
      },
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      id: string;
      submittedAt: string;
      reason: string | null;
    };
    // Same record, same timestamp, ORIGINAL reason — not the second body's.
    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody.submittedAt).toBe(firstBody.submittedAt);
    expect(secondBody.reason).toBe("first");

    // Exactly one row in the DB.
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.complaints)
      .where(
        and(
          eq(schema.complaints.orderId, order.id),
          eq(schema.complaints.reason, "withdrawal"),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it("does NOT re-send emails on the second submission", async () => {
    const user = await seedVerifiedCustomer({ email: "idem-mail@example.com" });
    const order = await seedAcceptedOrder({
      userId: user.id,
      customerEmail: user.email,
    });
    await app.request(`/orders/${order.orderNumber}/withdrawal`, {
      method: "POST",
      headers: cookieHeader(user.cookie),
      body: JSON.stringify({}),
    });
    const stub = getStubTransportForTests();
    const firstAckCount = stub.sent.filter(
      (e) => e.templateId === "orders.withdrawal-received" && e.to === user.email,
    ).length;
    expect(firstAckCount).toBe(1);

    await app.request(`/orders/${order.orderNumber}/withdrawal`, {
      method: "POST",
      headers: cookieHeader(user.cookie),
      body: JSON.stringify({}),
    });
    const secondAckCount = stub.sent.filter(
      (e) => e.templateId === "orders.withdrawal-received" && e.to === user.email,
    ).length;
    expect(secondAckCount).toBe(1);
  });
});

// ─── POST failure modes ───────────────────────────────────────────────────

describe("POST /orders/:orderNumber/withdrawal — failure modes", () => {
  it("returns 404 for an unknown order", async () => {
    const user = await seedVerifiedCustomer({ email: "post-404@example.com" });
    const res = await app.request("/orders/2026-05-99999/withdrawal", {
      method: "POST",
      headers: cookieHeader(user.cookie),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 for someone else's order (enumeration-resistant)", async () => {
    const userA = await seedVerifiedCustomer({ email: "post-a@example.com" });
    const userB = await seedVerifiedCustomer({ email: "post-b@example.com" });
    const order = await seedAcceptedOrder({
      userId: userB.id,
      customerEmail: userB.email,
    });
    const res = await app.request(`/orders/${order.orderNumber}/withdrawal`, {
      method: "POST",
      headers: cookieHeader(userA.cookie),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);

    // No row written.
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.complaints)
      .where(eq(schema.complaints.orderId, order.id));
    expect(rows).toHaveLength(0);
  });

  it("returns 422 type=withdrawal-window-expired for a >14-day-old order", async () => {
    const user = await seedVerifiedCustomer({ email: "post-old@example.com" });
    const order = await seedAcceptedOrder({
      userId: user.id,
      customerEmail: user.email,
      acceptedDaysAgo: 30,
    });
    const res = await app.request(`/orders/${order.orderNumber}/withdrawal`, {
      method: "POST",
      headers: cookieHeader(user.cookie),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { type: string };
    expect(body.type).toBe("/problems/withdrawal-window-expired");
  });

  it("returns 422 type=withdrawal-not-accepted for an order still processing", async () => {
    const user = await seedVerifiedCustomer({ email: "post-proc@example.com" });
    const db = getDb();
    const orderNumber = `2026-05-${String(Math.floor(Math.random() * 99999)).padStart(5, "0")}`;
    const [order] = await db
      .insert(schema.orders)
      .values({
        orderNumber,
        customerId: user.id,
        idempotencyKey: `test-${crypto.randomUUID()}`,
        status: "processing",
        paymentMethod: "pay_at_store",
        customerEmail: user.email,
        customerPhone: "+359888000000",
        customerName: "Иван",
        subtotalCents: "1000",
        discountPercent: "0",
        discountAmountCents: "0",
        totalCents: "1000",
      })
      .returning();
    const res = await app.request(`/orders/${order!.orderNumber}/withdrawal`, {
      method: "POST",
      headers: cookieHeader(user.cookie),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { type: string };
    expect(body.type).toBe("/problems/withdrawal-not-accepted");
  });

  it("rejects a reason >2000 chars with 400 (Zod validation)", async () => {
    const user = await seedVerifiedCustomer({ email: "post-toolong@example.com" });
    const order = await seedAcceptedOrder({
      userId: user.id,
      customerEmail: user.email,
    });
    const res = await app.request(`/orders/${order.orderNumber}/withdrawal`, {
      method: "POST",
      headers: cookieHeader(user.cookie),
      body: JSON.stringify({ reason: "x".repeat(2001) }),
    });
    expect(res.status).toBe(400);
  });
});

// ─── GET withdrawal ────────────────────────────────────────────────────────

describe("GET /orders/:orderNumber/withdrawal", () => {
  it("returns 404 when no withdrawal has been submitted for this order", async () => {
    const user = await seedVerifiedCustomer({ email: "get-none@example.com" });
    const order = await seedAcceptedOrder({
      userId: user.id,
      customerEmail: user.email,
    });
    const res = await app.request(`/orders/${order.orderNumber}/withdrawal`, {
      method: "GET",
      headers: cookieHeader(user.cookie),
    });
    expect(res.status).toBe(404);
  });

  it("returns the persisted record after submission", async () => {
    const user = await seedVerifiedCustomer({ email: "get-ok@example.com" });
    const order = await seedAcceptedOrder({
      userId: user.id,
      customerEmail: user.email,
    });
    await app.request(`/orders/${order.orderNumber}/withdrawal`, {
      method: "POST",
      headers: cookieHeader(user.cookie),
      body: JSON.stringify({ reason: "Не съответства на описанието." }),
    });
    const res = await app.request(`/orders/${order.orderNumber}/withdrawal`, {
      method: "GET",
      headers: cookieHeader(user.cookie),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reason: string | null; orderNumber: string };
    expect(body.orderNumber).toBe(order.orderNumber);
    expect(body.reason).toBe("Не съответства на описанието.");
  });

  it("returns 404 for someone else's order", async () => {
    const userA = await seedVerifiedCustomer({ email: "get-a@example.com" });
    const userB = await seedVerifiedCustomer({ email: "get-b@example.com" });
    const order = await seedAcceptedOrder({
      userId: userB.id,
      customerEmail: userB.email,
    });
    await app.request(`/orders/${order.orderNumber}/withdrawal`, {
      method: "POST",
      headers: cookieHeader(userB.cookie),
      body: JSON.stringify({}),
    });
    const res = await app.request(`/orders/${order.orderNumber}/withdrawal`, {
      method: "GET",
      headers: cookieHeader(userA.cookie),
    });
    expect(res.status).toBe(404);
  });
});

// ─── Order DTO ─────────────────────────────────────────────────────────────

describe("Order DTO — acceptedAt is surfaced for FE eligibility computation", () => {
  it("includes acceptedAt on GET /orders/:orderNumber when status is accepted", async () => {
    const user = await seedVerifiedCustomer({ email: "dto-ok@example.com" });
    const order = await seedAcceptedOrder({
      userId: user.id,
      customerEmail: user.email,
    });
    const res = await app.request(`/orders/${order.orderNumber}`, {
      method: "GET",
      headers: cookieHeader(user.cookie),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { acceptedAt: string | null };
    expect(body.acceptedAt).toBeTruthy();
    expect(typeof body.acceptedAt).toBe("string");
  });
});
