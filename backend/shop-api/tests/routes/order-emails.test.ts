import { hashPassword } from "@shop/auth";
import { schema } from "@shop/db";
import {
  ORDER_CONFIRMATION_TEMPLATE_ID,
  type EmailTransport,
  type OutgoingEmail,
} from "@shop/email";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { sessionCookieName } from "../../src/lib/cookies.js";
import { getDb } from "../../src/lib/db.js";
import {
  _resetEmailTransportForTests,
  getEmailTransport,
  getStubTransportForTests,
  setEmailTransportForTests,
} from "../../src/lib/emails.js";
import { seedSmallCatalog } from "../fixtures.js";

/**
 * Integration tests for the order-confirmation email wired into POST /orders.
 *
 * What this file covers (the unit-level template tests live next to the
 * template at backend/email/tests/order-confirmation.test.ts; here we only
 * exercise the wiring):
 *
 *   - The email is sent at all, with the right templateId and recipient.
 *   - The email subject and body carry the just-issued orderNumber.
 *   - Line-item snapshots and totals are present in the body.
 *   - Idempotency replay does NOT re-send.
 *   - A transport failure does NOT fail the order (best-effort posture).
 *
 * The stub transport is reset in `tests/setup/per-test.ts:beforeEach` so
 * each test starts with `stub.sent === []`.
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

function cookieHeader(token: string): string {
  return `${sessionCookieName()}=${token}`;
}

async function loginVerifiedCustomer(opts?: {
  email?: string;
  fullName?: string;
  phone?: string;
}): Promise<{ cookie: string; userId: string; email: string; fullName: string }> {
  const db = getDb();
  const email = (opts?.email ?? "order-mail-buyer@example.com").toLowerCase();
  const fullName = opts?.fullName ?? "Иван Иванов";
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
    fullName,
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
  return { cookie: cookieHeader(token), userId: user.id, email, fullName };
}

async function addToCart(
  cookie: string,
  productId: string,
  quantity: number,
): Promise<void> {
  const res = await app.request("/cart/items", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ productId, quantity }),
  });
  if (res.status !== 200) {
    throw new Error(`addToCart failed: ${res.status}`);
  }
}

const VALID_ADDR = {
  city: "София",
  postalCode: "1000",
  street: "бул. Витоша 25",
  apartmentOrOffice: "ап. 4",
};

function newKey(prefix = "order-mail"): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

describe("POST /orders sends an order-confirmation email", () => {
  it("queues exactly one confirmation with the right templateId and recipient", async () => {
    const { p1 } = await seedSmallCatalog();
    const { cookie, email, fullName } = await loginVerifiedCustomer();
    await addToCart(cookie, p1.id, 1);

    const res = await app.request("/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": newKey(),
        Cookie: cookie,
      },
      body: JSON.stringify({ paymentMethod: "pay_at_store" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { orderNumber: string };
    expect(body.orderNumber).toMatch(/^\d{4}-\d{2}-\d{5}$/);

    const stub = getStubTransportForTests();
    const confirmations = stub.sent.filter(
      (e) => e.templateId === ORDER_CONFIRMATION_TEMPLATE_ID && e.to === email,
    );
    expect(confirmations).toHaveLength(1);

    const mail = confirmations[0]!;
    expect(mail.subject).toContain(body.orderNumber);
    // Bulgarian greeting personalised with the customer's name.
    expect(mail.text).toContain(fullName);
    // Carries the order number in the body.
    expect(mail.text).toContain(body.orderNumber);
    expect(mail.html).toContain(body.orderNumber);
    // Carries the line item's snapshot name and code.
    expect(mail.text).toContain("Demo Headphones");
    expect(mail.text).toContain("DEMO-001");
    // Sofia-timezone label appears (Art. 11a-style timestamp framing).
    expect(mail.text).toContain("Европа/София");
  });

  it("includes the delivery-address snapshot for cash_on_delivery", async () => {
    const { p2 } = await seedSmallCatalog();
    const { cookie, email } = await loginVerifiedCustomer({
      email: "cod-buyer@example.com",
    });
    await addToCart(cookie, p2.id, 1);

    const res = await app.request("/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": newKey(),
        Cookie: cookie,
      },
      body: JSON.stringify({
        paymentMethod: "cash_on_delivery",
        deliveryAddress: VALID_ADDR,
      }),
    });
    expect(res.status).toBe(201);

    const stub = getStubTransportForTests();
    const mail = stub.findLast(
      (e) => e.templateId === ORDER_CONFIRMATION_TEMPLATE_ID && e.to === email,
    );
    expect(mail).toBeDefined();
    expect(mail!.text).toContain("бул. Витоша 25");
    expect(mail!.text).toContain("ап. 4");
    expect(mail!.text).toContain("1000");
    expect(mail!.text).toContain("София");
    expect(mail!.text).toContain("Наложен платеж");
  });

  it("includes withdrawal-rights pointer (EU 2023/2673 / чл. 50)", async () => {
    const { p1 } = await seedSmallCatalog();
    const { cookie, email } = await loginVerifiedCustomer({
      email: "withdrawal-pointer@example.com",
    });
    await addToCart(cookie, p1.id, 1);

    await app.request("/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": newKey(),
        Cookie: cookie,
      },
      body: JSON.stringify({ paymentMethod: "pay_at_store" }),
    });

    const stub = getStubTransportForTests();
    const mail = stub.findLast(
      (e) => e.templateId === ORDER_CONFIRMATION_TEMPLATE_ID && e.to === email,
    );
    expect(mail).toBeDefined();
    expect(mail!.text).toContain("чл. 50");
    expect(mail!.text).toContain("2023/2673");
    expect(mail!.text).toContain("14");
  });

  it("does NOT re-send the confirmation on idempotent replay", async () => {
    const { p1 } = await seedSmallCatalog();
    const { cookie, email } = await loginVerifiedCustomer({
      email: "idem-replay@example.com",
    });
    await addToCart(cookie, p1.id, 1);

    const key = newKey();
    const r1 = await app.request("/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
        Cookie: cookie,
      },
      body: JSON.stringify({ paymentMethod: "pay_at_store" }),
    });
    expect(r1.status).toBe(201);

    const stub = getStubTransportForTests();
    const firstCount = stub.sent.filter(
      (e) => e.templateId === ORDER_CONFIRMATION_TEMPLATE_ID && e.to === email,
    ).length;
    expect(firstCount).toBe(1);

    // Same idempotency key → replay path returns the original order verbatim
    // and MUST NOT re-fire the side-effects (spamming the customer on every
    // network retry is the Stripe / RFC idempotency anti-pattern).
    const r2 = await app.request("/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
        Cookie: cookie,
      },
      body: JSON.stringify({ paymentMethod: "pay_at_store" }),
    });
    expect(r2.status).toBe(201);
    const r1Body = (await r1.json()) as { orderNumber: string };
    const r2Body = (await r2.json()) as { orderNumber: string };
    expect(r2Body.orderNumber).toBe(r1Body.orderNumber);

    const secondCount = stub.sent.filter(
      (e) => e.templateId === ORDER_CONFIRMATION_TEMPLATE_ID && e.to === email,
    ).length;
    expect(secondCount).toBe(1);
  });

  it("a transport-level send failure does NOT fail the order", async () => {
    const { p1 } = await seedSmallCatalog();
    const { cookie, email } = await loginVerifiedCustomer({
      email: "transport-fail@example.com",
    });
    await addToCart(cookie, p1.id, 1);

    // Swap in a throwing transport for this test. The per-test beforeEach
    // resets the cache before the next test, so the failure-mode here does
    // not leak into the rest of the suite.
    const throwingTransport: EmailTransport = {
      async send(_email: OutgoingEmail): Promise<never> {
        throw new Error("simulated transport failure");
      },
    };
    setEmailTransportForTests(throwingTransport);

    const res = await app.request("/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": newKey(),
        Cookie: cookie,
      },
      body: JSON.stringify({ paymentMethod: "pay_at_store" }),
    });
    // The order must still be placed — the email is best-effort.
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      orderNumber: string;
      customerEmail: string;
    };
    expect(body.orderNumber).toMatch(/^\d{4}-\d{2}-\d{5}$/);
    expect(body.customerEmail).toBe(email);

    // Restore the stub for any follow-on assertions in this test (the
    // beforeEach hook will re-reset for the next test).
    _resetEmailTransportForTests();
    getEmailTransport();
  });
});
