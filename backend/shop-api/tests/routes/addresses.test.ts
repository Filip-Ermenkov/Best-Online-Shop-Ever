import { hashPassword } from "@shop/auth";
import { schema } from "@shop/db";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { sessionCookieName } from "../../src/lib/cookies.js";
import { getDb } from "../../src/lib/db.js";

/**
 * Integration tests for the customer address book.
 *
 * Routes under test (all requireAuth):
 *   - GET    /addresses          list the current user's live addresses
 *   - POST   /addresses          create one
 *   - PATCH  /addresses/{id}     partial update one
 *   - DELETE /addresses/{id}     soft-delete one
 *
 * Posture mirrors the rest of the account surface: every row operation is
 * scoped to (userId = current user, deleted_at IS NULL), so an address that
 * doesn't exist / belongs to someone else / was removed all return the SAME
 * 404 (enumeration-resistant by contract).
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

async function loginAndGetCookie(email: string): Promise<string> {
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
  return token;
}

async function seedCustomer(email = "buyer@example.com"): Promise<{
  id: string;
  email: string;
  cookie: string;
}> {
  const db = getDb();
  const lower = email.toLowerCase();
  const passwordHash = await hashPassword(VALID_PASSWORD);
  const [user] = await db
    .insert(schema.users)
    .values({
      email: lower,
      passwordHash,
      role: "customer",
      accountType: "personal",
      emailVerifiedAt: new Date(),
    })
    .returning();
  if (!user) throw new Error("user seed failed");
  await db.insert(schema.customerProfiles).values({
    userId: user.id,
    fullName: "Иван Иванов",
    phone: "+359888000000",
  });
  return { id: user.id, email: lower, cookie: await loginAndGetCookie(lower) };
}

interface AddressBody {
  label?: string | null;
  city?: string;
  postalCode?: string;
  street?: string;
  apartmentOrOffice?: string | null;
}

function createAddress(cookie: string, body: AddressBody) {
  return app.request("/addresses", {
    method: "POST",
    headers: cookieHeader(cookie),
    body: JSON.stringify(body),
  });
}

function listAddresses(cookie: string) {
  return app.request("/addresses", {
    method: "GET",
    headers: { Cookie: `${sessionCookieName()}=${cookie}` },
  });
}

const VALID_ADDRESS: AddressBody = {
  label: "Вкъщи",
  city: "София",
  postalCode: "1000",
  street: "бул. Витоша 1",
  apartmentOrOffice: "ап. 5",
};

// ─── Auth gate ────────────────────────────────────────────────────────────────

describe("address book — auth", () => {
  it("GET /addresses requires a session", async () => {
    const res = await app.request("/addresses", { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("POST /addresses requires a session", async () => {
    const res = await app.request("/addresses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_ADDRESS),
    });
    expect(res.status).toBe(401);
  });

  it("DELETE /addresses/{id} requires a session", async () => {
    const res = await app.request(
      "/addresses/00000000-0000-0000-0000-000000000000",
      { method: "DELETE" },
    );
    expect(res.status).toBe(401);
  });
});

// ─── Create + list ─────────────────────────────────────────────────────────────

describe("address book — create & list", () => {
  it("starts empty", async () => {
    const { cookie } = await seedCustomer();
    const res = await listAddresses(cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  it("creates an address and returns the full shape", async () => {
    const { cookie } = await seedCustomer();
    const res = await createAddress(cookie, VALID_ADDRESS);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      label: "Вкъщи",
      city: "София",
      postalCode: "1000",
      street: "бул. Витоша 1",
      apartmentOrOffice: "ап. 5",
    });
    expect(typeof body.id).toBe("string");
    expect(typeof body.createdAt).toBe("string");
  });

  it("created address shows up in the list", async () => {
    const { cookie } = await seedCustomer();
    await createAddress(cookie, VALID_ADDRESS);
    const res = await listAddresses(cookie);
    const body = (await res.json()) as { items: { city: string }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.city).toBe("София");
  });

  it("optional label + apartment default to null when omitted", async () => {
    const { cookie } = await seedCustomer();
    const res = await createAddress(cookie, {
      city: "Пловдив",
      postalCode: "4000",
      street: "ул. Главна 2",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.label).toBeNull();
    expect(body.apartmentOrOffice).toBeNull();
  });

  it("trims surrounding whitespace on create", async () => {
    const { cookie } = await seedCustomer();
    const res = await createAddress(cookie, {
      city: "  Варна  ",
      postalCode: " 9000 ",
      street: "  ул. Морска 3  ",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.city).toBe("Варна");
    expect(body.postalCode).toBe("9000");
    expect(body.street).toBe("ул. Морска 3");
  });

  it("lists addresses oldest-first", async () => {
    const { cookie } = await seedCustomer();
    await createAddress(cookie, { ...VALID_ADDRESS, city: "Първи" });
    await createAddress(cookie, { ...VALID_ADDRESS, city: "Втори" });
    const res = await listAddresses(cookie);
    const body = (await res.json()) as { items: { city: string }[] };
    expect(body.items.map((a) => a.city)).toEqual(["Първи", "Втори"]);
  });
});

// ─── Create validation ──────────────────────────────────────────────────────────

describe("address book — create validation", () => {
  it("rejects a non-4-digit postal code", async () => {
    const { cookie } = await seedCustomer();
    const res = await createAddress(cookie, { ...VALID_ADDRESS, postalCode: "10000" });
    expect(res.status).toBe(400);
  });

  it("rejects a postal code with letters", async () => {
    const { cookie } = await seedCustomer();
    const res = await createAddress(cookie, { ...VALID_ADDRESS, postalCode: "BG10" });
    expect(res.status).toBe(400);
  });

  it("rejects a missing city", async () => {
    const { cookie } = await seedCustomer();
    const res = await createAddress(cookie, {
      postalCode: "1000",
      street: "бул. Витоша 1",
    });
    expect(res.status).toBe(400);
  });

  it("rejects an empty street", async () => {
    const { cookie } = await seedCustomer();
    const res = await createAddress(cookie, { ...VALID_ADDRESS, street: "   " });
    expect(res.status).toBe(400);
  });

  it("rejects unknown keys (.strict)", async () => {
    const { cookie } = await seedCustomer();
    const res = await app.request("/addresses", {
      method: "POST",
      headers: cookieHeader(cookie),
      body: JSON.stringify({ ...VALID_ADDRESS, userId: "evil", isDefault: true }),
    });
    expect(res.status).toBe(400);
  });
});

// ─── Update ──────────────────────────────────────────────────────────────────────

describe("address book — update", () => {
  async function seedWithOneAddress() {
    const customer = await seedCustomer();
    const res = await createAddress(customer.cookie, VALID_ADDRESS);
    const created = (await res.json()) as { id: string };
    return { ...customer, addressId: created.id };
  }

  it("updates a single field and persists it", async () => {
    const { cookie, addressId } = await seedWithOneAddress();
    const res = await app.request(`/addresses/${addressId}`, {
      method: "PATCH",
      headers: cookieHeader(cookie),
      body: JSON.stringify({ city: "Бургас" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { city: string; street: string };
    expect(body.city).toBe("Бургас");
    // Untouched field stays.
    expect(body.street).toBe("бул. Витоша 1");
  });

  it("clears the label with an explicit null", async () => {
    const { cookie, addressId } = await seedWithOneAddress();
    const res = await app.request(`/addresses/${addressId}`, {
      method: "PATCH",
      headers: cookieHeader(cookie),
      body: JSON.stringify({ label: null }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { label: string | null };
    expect(body.label).toBeNull();
  });

  it("is a no-op (200, unchanged) when nothing differs", async () => {
    const { cookie, addressId } = await seedWithOneAddress();
    const res = await app.request(`/addresses/${addressId}`, {
      method: "PATCH",
      headers: cookieHeader(cookie),
      body: JSON.stringify({ city: "София" }), // identical to stored
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { city: string };
    expect(body.city).toBe("София");
  });

  it("rejects a bad postal code on update", async () => {
    const { cookie, addressId } = await seedWithOneAddress();
    const res = await app.request(`/addresses/${addressId}`, {
      method: "PATCH",
      headers: cookieHeader(cookie),
      body: JSON.stringify({ postalCode: "abc" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects unknown keys on update (.strict)", async () => {
    const { cookie, addressId } = await seedWithOneAddress();
    const res = await app.request(`/addresses/${addressId}`, {
      method: "PATCH",
      headers: cookieHeader(cookie),
      body: JSON.stringify({ userId: "evil" }),
    });
    expect(res.status).toBe(400);
  });

  it("404s when updating an address that does not exist", async () => {
    const { cookie } = await seedCustomer();
    // A well-formed (RFC-variant) UUID that simply isn't in the DB — so the
    // param passes Zod's .uuid() check and we reach the not-found branch
    // rather than a 400 validation error.
    const res = await app.request(
      "/addresses/99999999-9999-4999-a999-999999999999",
      {
        method: "PATCH",
        headers: cookieHeader(cookie),
        body: JSON.stringify({ city: "X" }),
      },
    );
    expect(res.status).toBe(404);
  });
});

// ─── Delete (soft) ──────────────────────────────────────────────────────────────

describe("address book — delete", () => {
  async function seedWithOneAddress() {
    const customer = await seedCustomer();
    const res = await createAddress(customer.cookie, VALID_ADDRESS);
    const created = (await res.json()) as { id: string };
    return { ...customer, addressId: created.id };
  }

  it("soft-deletes and removes it from the list", async () => {
    const { cookie, addressId } = await seedWithOneAddress();
    const del = await app.request(`/addresses/${addressId}`, {
      method: "DELETE",
      headers: { Cookie: `${sessionCookieName()}=${cookie}` },
    });
    expect(del.status).toBe(204);

    const list = await listAddresses(cookie);
    const body = (await list.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  it("keeps the row in the DB with deleted_at set (soft delete)", async () => {
    const { id: userId, cookie, addressId } = await seedWithOneAddress();
    await app.request(`/addresses/${addressId}`, {
      method: "DELETE",
      headers: { Cookie: `${sessionCookieName()}=${cookie}` },
    });
    const db = getDb();
    const [row] = await db
      .select()
      .from(schema.addresses)
      .where(
        and(
          eq(schema.addresses.id, addressId),
          eq(schema.addresses.userId, userId),
        ),
      )
      .limit(1);
    expect(row).toBeTruthy();
    expect(row!.deletedAt).not.toBeNull();
  });

  it("404s on a second delete of the same address (idempotent-by-absence)", async () => {
    const { cookie, addressId } = await seedWithOneAddress();
    const first = await app.request(`/addresses/${addressId}`, {
      method: "DELETE",
      headers: { Cookie: `${sessionCookieName()}=${cookie}` },
    });
    expect(first.status).toBe(204);
    const second = await app.request(`/addresses/${addressId}`, {
      method: "DELETE",
      headers: { Cookie: `${sessionCookieName()}=${cookie}` },
    });
    expect(second.status).toBe(404);
  });

  it("404s when updating a soft-deleted address", async () => {
    const { cookie, addressId } = await seedWithOneAddress();
    await app.request(`/addresses/${addressId}`, {
      method: "DELETE",
      headers: { Cookie: `${sessionCookieName()}=${cookie}` },
    });
    const res = await app.request(`/addresses/${addressId}`, {
      method: "PATCH",
      headers: cookieHeader(cookie),
      body: JSON.stringify({ city: "X" }),
    });
    expect(res.status).toBe(404);
  });
});

// ─── Ownership isolation ──────────────────────────────────────────────────────

describe("address book — ownership", () => {
  it("a user cannot see another user's addresses", async () => {
    const alice = await seedCustomer("alice@example.com");
    const bob = await seedCustomer("bob@example.com");
    await createAddress(alice.cookie, VALID_ADDRESS);

    const res = await listAddresses(bob.cookie);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  it("a user cannot update another user's address (404)", async () => {
    const alice = await seedCustomer("alice@example.com");
    const bob = await seedCustomer("bob@example.com");
    const created = (await (
      await createAddress(alice.cookie, VALID_ADDRESS)
    ).json()) as { id: string };

    const res = await app.request(`/addresses/${created.id}`, {
      method: "PATCH",
      headers: cookieHeader(bob.cookie),
      body: JSON.stringify({ city: "Хакнато" }),
    });
    expect(res.status).toBe(404);
  });

  it("a user cannot delete another user's address (404)", async () => {
    const alice = await seedCustomer("alice@example.com");
    const bob = await seedCustomer("bob@example.com");
    const created = (await (
      await createAddress(alice.cookie, VALID_ADDRESS)
    ).json()) as { id: string };

    const res = await app.request(`/addresses/${created.id}`, {
      method: "DELETE",
      headers: { Cookie: `${sessionCookieName()}=${bob.cookie}` },
    });
    expect(res.status).toBe(404);
  });
});

// ─── Per-user limit ──────────────────────────────────────────────────────────

describe("address book — per-user limit", () => {
  it("rejects the 21st live address with 422 but allows it after a delete", async () => {
    const { cookie } = await seedCustomer();
    let lastId = "";
    for (let i = 0; i < 20; i++) {
      const res = await createAddress(cookie, {
        ...VALID_ADDRESS,
        label: `addr-${i}`,
      });
      expect(res.status).toBe(201);
      lastId = ((await res.json()) as { id: string }).id;
    }
    // 21st is over the cap.
    const over = await createAddress(cookie, { ...VALID_ADDRESS, label: "over" });
    expect(over.status).toBe(422);

    // Free a slot by removing one, then the create succeeds.
    const del = await app.request(`/addresses/${lastId}`, {
      method: "DELETE",
      headers: { Cookie: `${sessionCookieName()}=${cookie}` },
    });
    expect(del.status).toBe(204);
    const retry = await createAddress(cookie, { ...VALID_ADDRESS, label: "after-delete" });
    expect(retry.status).toBe(201);
  });
});
