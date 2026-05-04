import { hashPassword } from "@shop/auth";
import { schema } from "@shop/db";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { sessionCookieName } from "../../src/lib/cookies.js";
import { getDb } from "../../src/lib/db.js";
import { seedImage, seedProduct, seedSmallCatalog } from "../fixtures.js";

let app: ReturnType<typeof buildApp>;

beforeAll(() => {
  app = buildApp();
});

const VALID_PASSWORD = "Hunter2!Bigger";

/**
 * Pull the session cookie out of a Set-Cookie header. Mirrors the helper in
 * auth.test.ts; we duplicate it locally so the cart suite is independent and
 * can be moved / split without cross-file imports.
 */
function extractSessionCookie(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const name = sessionCookieName();
  const match = setCookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match?.[1] ?? null;
}

/** Compose the Cookie header value for a request. */
function cookieHeader(token: string): string {
  return `${sessionCookieName()}=${token}`;
}

/** Seed a customer + log in. Returns the session cookie to thread into requests. */
async function loginCustomer(opts?: {
  email?: string;
  password?: string;
}): Promise<{ cookie: string; userId: string; email: string }> {
  const db = getDb();
  const email = (opts?.email ?? "cart@example.com").toLowerCase();
  const password = opts?.password ?? VALID_PASSWORD;
  const passwordHash = await hashPassword(password);
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
  if (!user) throw new Error("seed failed");
  await db.insert(schema.customerProfiles).values({
    userId: user.id,
    fullName: "Cart Tester",
    phone: "+359888000000",
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

// ─── Auth gate ─────────────────────────────────────────────────────────────

describe("Cart auth gate", () => {
  it("GET /cart returns 401 for anonymous requests", async () => {
    const res = await app.request("/cart", { method: "GET" });
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
  });

  it("POST /cart/items returns 401 for anonymous requests", async () => {
    const res = await app.request("/cart/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productId: "00000000-0000-0000-0000-000000000000" }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /cart/merge returns 401 for anonymous requests", async () => {
    const res = await app.request("/cart/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [] }),
    });
    expect(res.status).toBe(401);
  });
});

// ─── GET /cart ─────────────────────────────────────────────────────────────

describe("GET /cart", () => {
  it("returns an empty cart for a freshly-registered user", async () => {
    const { cookie } = await loginCustomer();

    const res = await app.request("/cart", {
      method: "GET",
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: unknown[];
      subtotalCents: number;
      itemCount: number;
      currency: string;
    };
    expect(body.items).toEqual([]);
    expect(body.subtotalCents).toBe(0);
    expect(body.itemCount).toBe(0);
    expect(body.currency).toBe("EUR");
  });

  it("hydrates each line with current price, stock status, and primary image", async () => {
    const { p1 } = await seedSmallCatalog();
    const { cookie } = await loginCustomer();

    const add = await app.request("/cart/items", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ productId: p1.id, quantity: 2 }),
    });
    expect(add.status).toBe(200);

    const res = await app.request("/cart", {
      method: "GET",
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        productId: string;
        slug: string;
        code: string;
        name: string;
        priceCents: number;
        currency: string;
        stockStatus: string;
        quantity: number;
        image: { url: string; alt: string } | null;
      }>;
      subtotalCents: number;
      itemCount: number;
    };
    expect(body.items).toHaveLength(1);
    const line = body.items[0]!;
    expect(line.productId).toBe(p1.id);
    expect(line.slug).toBe("demo-headphones");
    expect(line.name).toBe("Demo Headphones");
    expect(line.priceCents).toBe(9999);
    expect(line.stockStatus).toBe("in_stock");
    expect(line.quantity).toBe(2);
    expect(line.image).not.toBeNull();
    expect(line.image!.alt).toBe("front"); // lowest displayOrder picked
    expect(body.subtotalCents).toBe(9999 * 2);
    expect(body.itemCount).toBe(2);
  });

  it("excludes lines whose product has been soft-deleted", async () => {
    const { p1, p2 } = await seedSmallCatalog();
    const { cookie } = await loginCustomer();

    await app.request("/cart/items", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ productId: p1.id, quantity: 1 }),
    });
    await app.request("/cart/items", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ productId: p2.id, quantity: 3 }),
    });

    // Soft-delete p1 — the line stays in cart_items (cascade only fires on
    // hard delete) but the read should drop it.
    const db = getDb();
    await db
      .update(schema.products)
      .set({ deletedAt: new Date() })
      .where(eq(schema.products.id, p1.id));

    const res = await app.request("/cart", {
      method: "GET",
      headers: { Cookie: cookie },
    });
    const body = (await res.json()) as { items: Array<{ productId: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.productId).toBe(p2.id);
  });

  it("subtotal excludes out-of-stock lines but itemCount includes them", async () => {
    const { p1, p3 } = await seedSmallCatalog(); // p3 is out_of_stock by fixture
    const { cookie, userId } = await loginCustomer();

    // p1 (in stock) added through the API.
    await app.request("/cart/items", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ productId: p1.id, quantity: 2 }),
    });

    // p3 has to be inserted directly: the API blocks adds for out-of-stock.
    // This simulates "added to cart while in stock, then went out of stock".
    const db = getDb();
    await db
      .insert(schema.carts)
      .values({ userId })
      .onConflictDoNothing();
    await db.insert(schema.cartItems).values({
      cartUserId: userId,
      productId: p3.id,
      quantity: 1,
    });

    const res = await app.request("/cart", {
      method: "GET",
      headers: { Cookie: cookie },
    });
    const body = (await res.json()) as {
      items: Array<{ productId: string; stockStatus: string; quantity: number }>;
      subtotalCents: number;
      itemCount: number;
    };

    expect(body.items).toHaveLength(2);
    expect(body.itemCount).toBe(3); // 2 + 1
    expect(body.subtotalCents).toBe(9999 * 2); // only p1 contributes
    const oos = body.items.find((i) => i.productId === p3.id);
    expect(oos?.stockStatus).toBe("out_of_stock");
  });
});

// ─── POST /cart/items ──────────────────────────────────────────────────────

describe("POST /cart/items", () => {
  it("adds a new item with the requested quantity", async () => {
    const { p2 } = await seedSmallCatalog();
    const { cookie } = await loginCustomer();

    const res = await app.request("/cart/items", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ productId: p2.id, quantity: 3 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ productId: string; quantity: number }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.productId).toBe(p2.id);
    expect(body.items[0]!.quantity).toBe(3);
  });

  it("defaults quantity to 1 when omitted", async () => {
    const { p1 } = await seedSmallCatalog();
    const { cookie } = await loginCustomer();

    const res = await app.request("/cart/items", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ productId: p1.id }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ quantity: number }> };
    expect(body.items[0]!.quantity).toBe(1);
  });

  it("sums quantity on duplicate add (silent merge)", async () => {
    const { p1 } = await seedSmallCatalog();
    const { cookie } = await loginCustomer();

    await app.request("/cart/items", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ productId: p1.id, quantity: 2 }),
    });
    const res = await app.request("/cart/items", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ productId: p1.id, quantity: 5 }),
    });
    const body = (await res.json()) as { items: Array<{ quantity: number }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.quantity).toBe(7);
  });

  it("clamps the post-add quantity to the per-line cap (99)", async () => {
    const { p1 } = await seedSmallCatalog();
    const { cookie } = await loginCustomer();

    await app.request("/cart/items", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ productId: p1.id, quantity: 50 }),
    });
    const res = await app.request("/cart/items", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ productId: p1.id, quantity: 90 }),
    });
    const body = (await res.json()) as { items: Array<{ quantity: number }> };
    expect(body.items[0]!.quantity).toBe(99);
  });

  it("returns 404 for an unknown product", async () => {
    const { cookie } = await loginCustomer();

    const res = await app.request("/cart/items", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        productId: "00000000-0000-0000-0000-000000000000",
        quantity: 1,
      }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 for a soft-deleted product", async () => {
    const { p1 } = await seedSmallCatalog();
    const { cookie } = await loginCustomer();

    const db = getDb();
    await db
      .update(schema.products)
      .set({ deletedAt: new Date() })
      .where(eq(schema.products.id, p1.id));

    const res = await app.request("/cart/items", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ productId: p1.id, quantity: 1 }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 when adding an out-of-stock product", async () => {
    const { p3 } = await seedSmallCatalog(); // out_of_stock by fixture
    const { cookie } = await loginCustomer();

    const res = await app.request("/cart/items", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ productId: p3.id, quantity: 1 }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { type: string; status: number };
    expect(body.type).toBe("/problems/out-of-stock");
  });

  it("rejects quantity > 99 with 400", async () => {
    const { p1 } = await seedSmallCatalog();
    const { cookie } = await loginCustomer();

    const res = await app.request("/cart/items", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ productId: p1.id, quantity: 100 }),
    });
    expect(res.status).toBe(400);
  });
});

// ─── PATCH /cart/items/:productId ──────────────────────────────────────────

describe("PATCH /cart/items/:productId", () => {
  it("sets the absolute quantity", async () => {
    const { p1 } = await seedSmallCatalog();
    const { cookie } = await loginCustomer();

    await app.request("/cart/items", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ productId: p1.id, quantity: 2 }),
    });

    const res = await app.request(`/cart/items/${p1.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ quantity: 5 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ quantity: number }> };
    expect(body.items[0]!.quantity).toBe(5);
  });

  it("returns 404 when the line does not exist", async () => {
    const { p1 } = await seedSmallCatalog();
    const { cookie } = await loginCustomer();

    const res = await app.request(`/cart/items/${p1.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ quantity: 3 }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects quantity < 1 with 400 (use DELETE to remove)", async () => {
    const { p1 } = await seedSmallCatalog();
    const { cookie } = await loginCustomer();

    await app.request("/cart/items", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ productId: p1.id, quantity: 1 }),
    });

    const res = await app.request(`/cart/items/${p1.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ quantity: 0 }),
    });
    expect(res.status).toBe(400);
  });
});

// ─── DELETE /cart/items/:productId ─────────────────────────────────────────

describe("DELETE /cart/items/:productId", () => {
  it("removes the line", async () => {
    const { p1 } = await seedSmallCatalog();
    const { cookie } = await loginCustomer();

    await app.request("/cart/items", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ productId: p1.id, quantity: 2 }),
    });

    const res = await app.request(`/cart/items/${p1.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  it("is idempotent (200 even when the line was not present)", async () => {
    const { p1 } = await seedSmallCatalog();
    const { cookie } = await loginCustomer();

    const res = await app.request(`/cart/items/${p1.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });
});

// ─── DELETE /cart ──────────────────────────────────────────────────────────

describe("DELETE /cart", () => {
  it("clears every line", async () => {
    const { p1, p2 } = await seedSmallCatalog();
    const { cookie } = await loginCustomer();

    await app.request("/cart/items", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ productId: p1.id, quantity: 2 }),
    });
    await app.request("/cart/items", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ productId: p2.id, quantity: 3 }),
    });

    const res = await app.request("/cart", {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: unknown[];
      subtotalCents: number;
      itemCount: number;
    };
    expect(body.items).toEqual([]);
    expect(body.subtotalCents).toBe(0);
    expect(body.itemCount).toBe(0);
  });
});

// ─── POST /cart/merge ──────────────────────────────────────────────────────

describe("POST /cart/merge", () => {
  it("is a no-op on an empty merge body", async () => {
    const { p1 } = await seedSmallCatalog();
    const { cookie } = await loginCustomer();

    await app.request("/cart/items", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ productId: p1.id, quantity: 2 }),
    });

    const res = await app.request("/cart/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ items: [] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ quantity: number }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.quantity).toBe(2);
  });

  it("inserts new lines and sums duplicates with the existing server cart", async () => {
    const { p1, p2 } = await seedSmallCatalog();
    const { cookie } = await loginCustomer();

    // Server-side: p1=2.
    await app.request("/cart/items", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ productId: p1.id, quantity: 2 }),
    });

    // Guest cart: p1=3, p2=4.
    const res = await app.request("/cart/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        items: [
          { productId: p1.id, quantity: 3 },
          { productId: p2.id, quantity: 4 },
        ],
      }),
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      items: Array<{ productId: string; quantity: number }>;
    };
    expect(body.items).toHaveLength(2);
    const map = new Map(body.items.map((i) => [i.productId, i.quantity]));
    expect(map.get(p1.id)).toBe(5); // 2 + 3
    expect(map.get(p2.id)).toBe(4); // new
  });

  it("dedupes a guest cart that lists the same product twice", async () => {
    const { p1 } = await seedSmallCatalog();
    const { cookie } = await loginCustomer();

    const res = await app.request("/cart/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        items: [
          { productId: p1.id, quantity: 2 },
          { productId: p1.id, quantity: 5 },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ quantity: number }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.quantity).toBe(7);
  });

  it("clamps the merged quantity to the per-line cap (99)", async () => {
    const { p1 } = await seedSmallCatalog();
    const { cookie } = await loginCustomer();

    await app.request("/cart/items", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ productId: p1.id, quantity: 80 }),
    });

    const res = await app.request("/cart/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        items: [{ productId: p1.id, quantity: 50 }],
      }),
    });
    const body = (await res.json()) as { items: Array<{ quantity: number }> };
    expect(body.items[0]!.quantity).toBe(99);
  });

  it("silently drops guest-cart entries for unknown / soft-deleted products", async () => {
    const { p1, p2 } = await seedSmallCatalog();
    const { cookie } = await loginCustomer();

    const db = getDb();
    await db
      .update(schema.products)
      .set({ deletedAt: new Date() })
      .where(eq(schema.products.id, p2.id));

    const res = await app.request("/cart/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        items: [
          { productId: p1.id, quantity: 1 },
          { productId: p2.id, quantity: 2 }, // soft-deleted
          {
            productId: "00000000-0000-0000-0000-000000000000", // unknown
            quantity: 3,
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ productId: string; quantity: number }>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.productId).toBe(p1.id);
    expect(body.items[0]!.quantity).toBe(1);
  });

  it("merges out-of-stock products (they may have gone OOS during the guest session)", async () => {
    // The merge endpoint accepts the product even if it's currently out of
    // stock — the customer added it while it was available, and the cart UI
    // will surface the OOS state on the read.
    const { p3 } = await seedSmallCatalog(); // out_of_stock
    const { cookie } = await loginCustomer();

    const res = await app.request("/cart/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        items: [{ productId: p3.id, quantity: 1 }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ productId: string; stockStatus: string }>;
      subtotalCents: number;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.stockStatus).toBe("out_of_stock");
    expect(body.subtotalCents).toBe(0); // OOS line excluded from subtotal
  });

  it("rejects more than 200 items in a single merge with 400", async () => {
    // We don't even need real product IDs for this — validation runs before
    // anything DB-touching.
    const { cookie } = await loginCustomer();
    const items = Array.from({ length: 201 }, () => ({
      productId: "00000000-0000-0000-0000-000000000000",
      quantity: 1,
    }));

    const res = await app.request("/cart/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ items }),
    });
    expect(res.status).toBe(400);
  });
});

// ─── Cross-user isolation ──────────────────────────────────────────────────

describe("Cross-user isolation", () => {
  it("each user sees only their own cart", async () => {
    const { p1, p2 } = await seedSmallCatalog();

    const a = await loginCustomer({ email: "alice@example.com" });
    const b = await loginCustomer({ email: "bob@example.com" });

    await app.request("/cart/items", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: a.cookie },
      body: JSON.stringify({ productId: p1.id, quantity: 2 }),
    });
    await app.request("/cart/items", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: b.cookie },
      body: JSON.stringify({ productId: p2.id, quantity: 5 }),
    });

    const aRead = await app.request("/cart", {
      method: "GET",
      headers: { Cookie: a.cookie },
    });
    const aBody = (await aRead.json()) as {
      items: Array<{ productId: string; quantity: number }>;
    };
    expect(aBody.items).toHaveLength(1);
    expect(aBody.items[0]!.productId).toBe(p1.id);
    expect(aBody.items[0]!.quantity).toBe(2);

    const bRead = await app.request("/cart", {
      method: "GET",
      headers: { Cookie: b.cookie },
    });
    const bBody = (await bRead.json()) as {
      items: Array<{ productId: string; quantity: number }>;
    };
    expect(bBody.items).toHaveLength(1);
    expect(bBody.items[0]!.productId).toBe(p2.id);
    expect(bBody.items[0]!.quantity).toBe(5);
  });
});

// ─── Multi-image primary selection ─────────────────────────────────────────

describe("Primary-image selection", () => {
  it("picks the lowest displayOrder image as primary", async () => {
    // seedSmallCatalog gives p1 two images; explicit additional check that
    // primary selection is by displayOrder ascending and ties broken by id.
    const product = await seedProduct({
      slug: "multi-img",
      code: "MULTI-001",
      name: "Multi-Image Product",
      priceCents: 1000,
    });
    await seedImage({
      productId: product.id,
      s3Key: "first.jpg",
      altText: "second-by-order",
      displayOrder: 5,
    });
    await seedImage({
      productId: product.id,
      s3Key: "second.jpg",
      altText: "first-by-order",
      displayOrder: 0,
    });

    const { cookie } = await loginCustomer();
    await app.request("/cart/items", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ productId: product.id, quantity: 1 }),
    });
    const res = await app.request("/cart", {
      method: "GET",
      headers: { Cookie: cookie },
    });
    const body = (await res.json()) as {
      items: Array<{ image: { alt: string } | null }>;
    };
    expect(body.items[0]!.image?.alt).toBe("first-by-order");
  });
});
