import { hashPassword } from "@shop/auth";
import { schema } from "@shop/db";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { sessionCookieName } from "../../src/lib/cookies.js";
import { getDb } from "../../src/lib/db.js";
import { seedProduct, seedSmallCatalog } from "../fixtures.js";

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

/**
 * Seed an email-verified personal customer + log in. Tests mostly want a
 * verified customer so they can hit POST /orders without tripping the email
 * gate — pass `verified: false` to test that gate.
 */
async function loginCustomer(opts?: {
  email?: string;
  password?: string;
  verified?: boolean;
  fullName?: string;
  phone?: string;
}): Promise<{ cookie: string; userId: string; email: string }> {
  const db = getDb();
  const email = (opts?.email ?? "buyer@example.com").toLowerCase();
  const password = opts?.password ?? VALID_PASSWORD;
  const verified = opts?.verified ?? true;
  const passwordHash = await hashPassword(password);
  const [user] = await db
    .insert(schema.users)
    .values({
      email,
      passwordHash,
      role: "customer",
      accountType: "personal",
      emailVerifiedAt: verified ? new Date() : null,
    })
    .returning();
  if (!user) throw new Error("seed failed");
  await db.insert(schema.customerProfiles).values({
    userId: user.id,
    fullName: opts?.fullName ?? "Иван Иванов",
    phone: opts?.phone ?? "+359888000000",
  });

  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, rememberMe: false }),
  });
  if (res.status !== 200) {
    throw new Error(`login failed in test setup: ${res.status}`);
  }
  const token = extractSessionCookie(res.headers.get("set-cookie"));
  if (!token) throw new Error("no session cookie returned");
  return { cookie: cookieHeader(token), userId: user.id, email };
}

/**
 * Seed a corporate customer + log in. Profile is corporate_profiles, not
 * customer_profiles, so the snapshot path differs.
 */
async function loginCorporate(opts?: {
  email?: string;
}): Promise<{ cookie: string; userId: string; email: string }> {
  const db = getDb();
  const email = (opts?.email ?? "corp@example.com").toLowerCase();
  const passwordHash = await hashPassword(VALID_PASSWORD);
  const [user] = await db
    .insert(schema.users)
    .values({
      email,
      passwordHash,
      role: "customer",
      accountType: "corporate",
      emailVerifiedAt: new Date(),
    })
    .returning();
  if (!user) throw new Error("seed failed");
  await db.insert(schema.corporateProfiles).values({
    userId: user.id,
    companyName: "Acme EOOD",
    eik: "203456789",
    vatNumber: "BG203456789",
    registeredAddress: "ул. Витоша 1, София 1000",
    mol: "Иван Петров",
    contactName: "Иван Петров",
    contactPhone: "+359888111111",
  });

  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: VALID_PASSWORD, rememberMe: false }),
  });
  if (res.status !== 200) {
    throw new Error(`corp login failed: ${res.status}`);
  }
  const token = extractSessionCookie(res.headers.get("set-cookie"));
  if (!token) throw new Error("no session cookie returned");
  return { cookie: cookieHeader(token), userId: user.id, email };
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

const COD_BODY = {
  paymentMethod: "cash_on_delivery" as const,
  deliveryAddress: VALID_ADDR,
  notes: "Позвънете преди доставка",
};

const PICKUP_BODY = {
  paymentMethod: "pay_at_store" as const,
};

function newKey(prefix = "key"): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

// ─── Auth gate ─────────────────────────────────────────────────────────────

describe("Orders auth gate", () => {
  it("POST /orders returns 401 for anonymous requests", async () => {
    const res = await app.request("/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": newKey(),
      },
      body: JSON.stringify(PICKUP_BODY),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
  });

  it("GET /orders returns 401 for anonymous requests", async () => {
    const res = await app.request("/orders", { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("GET /orders/:orderNumber returns 401 for anonymous requests", async () => {
    const res = await app.request("/orders/2026-05-00001", { method: "GET" });
    expect(res.status).toBe(401);
  });
});

// ─── Email-verified gate ───────────────────────────────────────────────────

describe("Orders email-verified gate", () => {
  it("POST /orders returns 403 if email is not verified", async () => {
    const { p1 } = await seedSmallCatalog();
    const { cookie } = await loginCustomer({ verified: false });
    await addToCart(cookie, p1.id, 1);

    const res = await app.request("/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": newKey(),
        Cookie: cookie,
      },
      body: JSON.stringify(PICKUP_BODY),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { type: string; status: number };
    expect(body.type).toBe("/problems/email-not-verified");
  });
});

// ─── Validation gates ──────────────────────────────────────────────────────

describe("Orders validation", () => {
  it("400 when Idempotency-Key header is missing", async () => {
    const { p1 } = await seedSmallCatalog();
    const { cookie } = await loginCustomer();
    await addToCart(cookie, p1.id, 1);

    const res = await app.request("/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(PICKUP_BODY),
    });
    expect(res.status).toBe(400);
  });

  it("400 when paymentMethod is invalid", async () => {
    const { p1 } = await seedSmallCatalog();
    const { cookie } = await loginCustomer();
    await addToCart(cookie, p1.id, 1);

    const res = await app.request("/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": newKey(),
        Cookie: cookie,
      },
      body: JSON.stringify({ paymentMethod: "credit_card" }),
    });
    expect(res.status).toBe(400);
  });

  it("400 when paymentMethod=cash_on_delivery and deliveryAddress is missing", async () => {
    const { p1 } = await seedSmallCatalog();
    const { cookie } = await loginCustomer();
    await addToCart(cookie, p1.id, 1);

    const res = await app.request("/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": newKey(),
        Cookie: cookie,
      },
      body: JSON.stringify({ paymentMethod: "cash_on_delivery" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors?: { path: string }[] };
    expect(body.errors?.[0]?.path).toBe("deliveryAddress");
  });

  it("422 when the cart is empty", async () => {
    const { cookie } = await loginCustomer();

    const res = await app.request("/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": newKey(),
        Cookie: cookie,
      },
      body: JSON.stringify(PICKUP_BODY),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { type: string };
    expect(body.type).toBe("/problems/cart-empty");
  });

  it("409 when the cart contains an out-of-stock item at submit time", async () => {
    const { p1 } = await seedSmallCatalog();
    const { cookie } = await loginCustomer();
    await addToCart(cookie, p1.id, 1);

    // Toggle stock OOS after adding. The cart-level POST validates stock at
    // add time, but order placement re-validates at submit time — race-safe.
    const db = getDb();
    await db
      .update(schema.products)
      .set({ stockStatus: "out_of_stock" })
      .where(eq(schema.products.id, p1.id));

    const res = await app.request("/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": newKey(),
        Cookie: cookie,
      },
      body: JSON.stringify(PICKUP_BODY),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      type: string;
      errors?: { path: string }[];
    };
    expect(body.type).toBe("/problems/out-of-stock");
    expect(body.errors?.length).toBeGreaterThan(0);
  });

  it("422 when the user has no profile row", async () => {
    // Hand-craft a verified user WITHOUT a customer_profiles row to exercise
    // the snapshot-missing branch.
    const db = getDb();
    const passwordHash = await hashPassword(VALID_PASSWORD);
    const [user] = await db
      .insert(schema.users)
      .values({
        email: "no-profile@example.com",
        passwordHash,
        role: "customer",
        accountType: "personal",
        emailVerifiedAt: new Date(),
      })
      .returning();
    if (!user) throw new Error("seed failed");

    const login = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "no-profile@example.com",
        password: VALID_PASSWORD,
        rememberMe: false,
      }),
    });
    expect(login.status).toBe(200);
    const token = extractSessionCookie(login.headers.get("set-cookie"))!;
    const cookie = cookieHeader(token);

    const { p1 } = await seedSmallCatalog();
    await addToCart(cookie, p1.id, 1);

    const res = await app.request("/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": newKey(),
        Cookie: cookie,
      },
      body: JSON.stringify(PICKUP_BODY),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { type: string };
    expect(body.type).toBe("/problems/profile-required");
  });
});

// ─── Happy paths ───────────────────────────────────────────────────────────

describe("POST /orders happy path", () => {
  it("places a pay_at_store order and clears the cart", async () => {
    const { p1, p2 } = await seedSmallCatalog();
    const { cookie } = await loginCustomer();
    await addToCart(cookie, p1.id, 2); // 9999 × 2 = 19998
    await addToCart(cookie, p2.id, 1); // 24999 × 1 = 24999

    const key = newKey("happy-pickup");
    const res = await app.request("/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
        Cookie: cookie,
      },
      body: JSON.stringify(PICKUP_BODY),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      orderNumber: string;
      status: string;
      paymentMethod: string;
      subtotalCents: number;
      discountPercent: number;
      discountAmountCents: number;
      totalCents: number;
      items: Array<{
        productCode: string;
        productName: string;
        unitPriceCents: number;
        quantity: number;
      }>;
      deliveryAddress: unknown;
      corporateData: unknown;
      customerName: string;
      customerEmail: string;
      customerPhone: string;
    };

    expect(body.status).toBe("processing");
    expect(body.paymentMethod).toBe("pay_at_store");
    expect(body.orderNumber).toMatch(/^\d{4}-\d{2}-\d{5}$/);
    expect(body.subtotalCents).toBe(19998 + 24999);
    expect(body.discountPercent).toBe(0);
    expect(body.discountAmountCents).toBe(0);
    expect(body.totalCents).toBe(19998 + 24999);
    expect(body.items).toHaveLength(2);
    expect(body.items.find((i) => i.productCode === "DEMO-001")?.quantity).toBe(2);
    expect(body.items.find((i) => i.productCode === "DEMO-002")?.quantity).toBe(1);
    expect(body.customerName).toBe("Иван Иванов");
    expect(body.customerPhone).toBe("+359888000000");
    expect(body.deliveryAddress).toBeNull(); // pickup → no address
    expect(body.corporateData).toBeNull(); // personal → no corp data

    // Cart cleared.
    const cart = await app.request("/cart", {
      method: "GET",
      headers: { Cookie: cookie },
    });
    expect(cart.status).toBe(200);
    const cartBody = (await cart.json()) as { items: unknown[] };
    expect(cartBody.items).toHaveLength(0);

    // status_history has the seed entry.
    const db = getDb();
    const history = await db
      .select()
      .from(schema.orderStatusHistory)
      .where(eq(schema.orderStatusHistory.orderId, body.id));
    expect(history).toHaveLength(1);
    expect(history[0]!.status).toBe("processing");
  });

  it("places a cash_on_delivery order and snapshots the delivery address", async () => {
    const { p1 } = await seedSmallCatalog();
    const { cookie } = await loginCustomer();
    await addToCart(cookie, p1.id, 3);

    const res = await app.request("/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": newKey("cod"),
        Cookie: cookie,
      },
      body: JSON.stringify(COD_BODY),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      paymentMethod: string;
      deliveryAddress: {
        city: string;
        postalCode: string;
        street: string;
        apartmentOrOffice: string | null;
      } | null;
      notes: string | null;
    };
    expect(body.paymentMethod).toBe("cash_on_delivery");
    expect(body.deliveryAddress).toMatchObject(VALID_ADDR);
    expect(body.notes).toBe("Позвънете преди доставка");

    // Verify the delivery address row landed.
    const db = getDb();
    const [addr] = await db
      .select()
      .from(schema.orderDeliveryAddress)
      .where(eq(schema.orderDeliveryAddress.orderId, body.id));
    expect(addr?.city).toBe("София");
    expect(addr?.street).toBe("бул. Витоша 25");
  });

  it("places a corporate order and snapshots the company data", async () => {
    const { p1 } = await seedSmallCatalog();
    const { cookie } = await loginCorporate();
    await addToCart(cookie, p1.id, 1);

    const res = await app.request("/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": newKey("corp"),
        Cookie: cookie,
      },
      body: JSON.stringify(PICKUP_BODY),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      customerName: string;
      customerPhone: string;
      corporateData: {
        companyName: string;
        eik: string;
        vatNumber: string | null;
        registeredAddress: string;
        mol: string;
        contactName: string;
      } | null;
    };

    expect(body.customerName).toBe("Иван Петров"); // contactName, not companyName
    expect(body.customerPhone).toBe("+359888111111");
    expect(body.corporateData).toMatchObject({
      companyName: "Acme EOOD",
      eik: "203456789",
      vatNumber: "BG203456789",
      mol: "Иван Петров",
    });
  });

  it("applies a per-user discount to subtotal and totalCents", async () => {
    const { p1, p2 } = await seedSmallCatalog();
    const { cookie, userId } = await loginCustomer();
    await addToCart(cookie, p1.id, 1); // 9999
    await addToCart(cookie, p2.id, 1); // 24999

    // Grant the user a 10% discount.
    const db = getDb();
    await db.insert(schema.discounts).values({
      userId,
      percent: "10.00",
      appliedByUserId: userId,
    });

    const res = await app.request("/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": newKey("disc"),
        Cookie: cookie,
      },
      body: JSON.stringify(PICKUP_BODY),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      subtotalCents: number;
      discountPercent: number;
      discountAmountCents: number;
      totalCents: number;
    };
    expect(body.subtotalCents).toBe(9999 + 24999); // 34998
    expect(body.discountPercent).toBe(10);
    expect(body.discountAmountCents).toBe(Math.floor(34998 * 0.1)); // 3499
    expect(body.totalCents).toBe(34998 - 3499); // 31499
  });

  it("snapshots the price even if the catalog price changes after placement", async () => {
    const { p1 } = await seedSmallCatalog();
    const { cookie } = await loginCustomer();
    await addToCart(cookie, p1.id, 1);

    const res = await app.request("/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": newKey("snap"),
        Cookie: cookie,
      },
      body: JSON.stringify(PICKUP_BODY),
    });
    const body = (await res.json()) as {
      orderNumber: string;
      items: Array<{ unitPriceCents: number }>;
    };
    expect(body.items[0]!.unitPriceCents).toBe(9999);

    // Bump the catalog price; the order's snapshot should not move.
    const db = getDb();
    await db
      .update(schema.products)
      .set({ priceCents: "12345" })
      .where(eq(schema.products.id, p1.id));

    const fetched = await app.request(`/orders/${body.orderNumber}`, {
      method: "GET",
      headers: { Cookie: cookie },
    });
    expect(fetched.status).toBe(200);
    const fb = (await fetched.json()) as {
      items: Array<{ unitPriceCents: number }>;
    };
    expect(fb.items[0]!.unitPriceCents).toBe(9999);
  });

  it("monthly orderNumber prefix matches the Sofia local month", async () => {
    const { p1 } = await seedSmallCatalog();
    const { cookie } = await loginCustomer();
    await addToCart(cookie, p1.id, 1);

    const res = await app.request("/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": newKey("month"),
        Cookie: cookie,
      },
      body: JSON.stringify(PICKUP_BODY),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { orderNumber: string };

    // Format is YYYY-MM-NNNNN. The exact YYYY-MM is "now in Europe/Sofia"
    // — assert the loose shape rather than a specific month so the test
    // doesn't break on Jan 1 / June 30 boundaries.
    const parts = body.orderNumber.split("-");
    expect(parts).toHaveLength(3);
    expect(Number(parts[0])).toBeGreaterThanOrEqual(2026);
    const month = Number(parts[1]);
    expect(month).toBeGreaterThanOrEqual(1);
    expect(month).toBeLessThanOrEqual(12);
    expect(parts[2]).toMatch(/^\d{5,}$/);
  });
});

// ─── Idempotency ───────────────────────────────────────────────────────────

describe("Idempotency replay", () => {
  it("returns the existing order when the same key is replayed by the same user", async () => {
    const { p1 } = await seedSmallCatalog();
    const { cookie } = await loginCustomer();
    await addToCart(cookie, p1.id, 2);

    const key = newKey("replay");
    const first = await app.request("/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
        Cookie: cookie,
      },
      body: JSON.stringify(PICKUP_BODY),
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { id: string; orderNumber: string };

    // Re-fill the cart so a non-idempotent retry would either succeed (placing
    // a SECOND order) or fail (cart already empty). We want the system to
    // recognise the replay and return the FIRST order without any side-effects.
    await addToCart(cookie, p1.id, 5);

    const second = await app.request("/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
        Cookie: cookie,
      },
      body: JSON.stringify(PICKUP_BODY),
    });
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as {
      id: string;
      orderNumber: string;
    };

    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody.orderNumber).toBe(firstBody.orderNumber);

    // Database has exactly ONE order, even though we POSTed twice.
    const db = getDb();
    const rows = await db.select().from(schema.orders);
    expect(rows).toHaveLength(1);

    // The cart we re-filled is still there — the replay did NOT clear it.
    const cart = await app.request("/cart", {
      method: "GET",
      headers: { Cookie: cookie },
    });
    const cartBody = (await cart.json()) as { items: unknown[] };
    expect(cartBody.items).toHaveLength(1);
  });

  it("placing an order with a fresh key creates a NEW order", async () => {
    const { p1 } = await seedSmallCatalog();
    const { cookie } = await loginCustomer();

    await addToCart(cookie, p1.id, 1);
    const a = await app.request("/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": newKey("a"),
        Cookie: cookie,
      },
      body: JSON.stringify(PICKUP_BODY),
    });
    expect(a.status).toBe(201);
    const aBody = (await a.json()) as { id: string };

    await addToCart(cookie, p1.id, 1);
    const b = await app.request("/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": newKey("b"),
        Cookie: cookie,
      },
      body: JSON.stringify(PICKUP_BODY),
    });
    expect(b.status).toBe(201);
    const bBody = (await b.json()) as { id: string };

    expect(bBody.id).not.toBe(aBody.id);

    const db = getDb();
    const rows = await db.select().from(schema.orders);
    expect(rows).toHaveLength(2);
  });
});

// ─── List + detail ─────────────────────────────────────────────────────────

describe("GET /orders", () => {
  it("returns an empty list for a user with no orders", async () => {
    const { cookie } = await loginCustomer();
    const res = await app.request("/orders", {
      method: "GET",
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  it("returns this user's orders newest first, scoped to caller", async () => {
    const { p1 } = await seedSmallCatalog();
    const { cookie } = await loginCustomer();

    await addToCart(cookie, p1.id, 1);
    await app.request("/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": newKey("first"),
        Cookie: cookie,
      },
      body: JSON.stringify(PICKUP_BODY),
    });

    await addToCart(cookie, p1.id, 1);
    await app.request("/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": newKey("second"),
        Cookie: cookie,
      },
      body: JSON.stringify(PICKUP_BODY),
    });

    // A different user with their own order — must NOT show up in our list.
    const other = await loginCustomer({ email: "stranger@example.com" });
    await addToCart(other.cookie, p1.id, 1);
    await app.request("/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": newKey("other"),
        Cookie: other.cookie,
      },
      body: JSON.stringify(PICKUP_BODY),
    });

    const res = await app.request("/orders", {
      method: "GET",
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ orderNumber: string; createdAt: string }>;
    };
    expect(body.items).toHaveLength(2);
    // Newest first by createdAt.
    expect(
      new Date(body.items[0]!.createdAt).getTime() >=
        new Date(body.items[1]!.createdAt).getTime(),
    ).toBe(true);
  });
});

describe("GET /orders/:orderNumber", () => {
  it("returns 404 for a non-existent orderNumber", async () => {
    const { cookie } = await loginCustomer();
    const res = await app.request("/orders/2099-12-99999", {
      method: "GET",
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the order belongs to a different user", async () => {
    const { p1 } = await seedSmallCatalog();
    const owner = await loginCustomer({ email: "owner@example.com" });
    await addToCart(owner.cookie, p1.id, 1);

    const placed = await app.request("/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": newKey("owner"),
        Cookie: owner.cookie,
      },
      body: JSON.stringify(PICKUP_BODY),
    });
    expect(placed.status).toBe(201);
    const placedBody = (await placed.json()) as { orderNumber: string };

    const intruder = await loginCustomer({ email: "intruder@example.com" });
    const res = await app.request(`/orders/${placedBody.orderNumber}`, {
      method: "GET",
      headers: { Cookie: intruder.cookie },
    });
    // Generic 404, NOT 403 — never confirm-or-deny existence to a stranger.
    expect(res.status).toBe(404);
  });

  it("returns the order for its rightful owner", async () => {
    const { p1 } = await seedSmallCatalog();
    const { cookie } = await loginCustomer();
    await addToCart(cookie, p1.id, 1);

    const placed = await app.request("/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": newKey("get"),
        Cookie: cookie,
      },
      body: JSON.stringify(COD_BODY),
    });
    const placedBody = (await placed.json()) as {
      id: string;
      orderNumber: string;
    };

    const res = await app.request(`/orders/${placedBody.orderNumber}`, {
      method: "GET",
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      orderNumber: string;
      deliveryAddress: unknown;
    };
    expect(body.id).toBe(placedBody.id);
    expect(body.orderNumber).toBe(placedBody.orderNumber);
    expect(body.deliveryAddress).toMatchObject(VALID_ADDR);
  });
});

// ─── Soft-deleted product silently dropped ─────────────────────────────────

describe("Cart hygiene at checkout", () => {
  it("silently drops a soft-deleted line and uses the remaining cart", async () => {
    const { p1, p2 } = await seedSmallCatalog();
    const { cookie } = await loginCustomer();
    await addToCart(cookie, p1.id, 1); // 9999
    await addToCart(cookie, p2.id, 2); // 24999 × 2 = 49998

    const db = getDb();
    await db
      .update(schema.products)
      .set({ deletedAt: new Date() })
      .where(eq(schema.products.id, p1.id));

    const res = await app.request("/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": newKey("hygiene"),
        Cookie: cookie,
      },
      body: JSON.stringify(PICKUP_BODY),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      subtotalCents: number;
      items: Array<{ productCode: string }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.productCode).toBe("DEMO-002");
    expect(body.subtotalCents).toBe(49998);
  });

  it("422 cart-empty when ALL lines are soft-deleted before submit", async () => {
    const { cookie } = await loginCustomer();
    const lonely = await seedProduct({
      slug: "lonely",
      code: "LONE-1",
      name: "Lonely",
      priceCents: 100,
    });
    await addToCart(cookie, lonely.id, 1);

    const db = getDb();
    await db
      .update(schema.products)
      .set({ deletedAt: new Date() })
      .where(eq(schema.products.id, lonely.id));

    const res = await app.request("/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": newKey("empty"),
        Cookie: cookie,
      },
      body: JSON.stringify(PICKUP_BODY),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { type: string };
    expect(body.type).toBe("/problems/cart-empty");
  });
});
