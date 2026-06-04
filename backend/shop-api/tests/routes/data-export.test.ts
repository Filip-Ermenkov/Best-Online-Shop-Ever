import { hashPassword } from "@shop/auth";
import { schema } from "@shop/db";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { sessionCookieName, visitorCookieName } from "../../src/lib/cookies.js";
import { getDb } from "../../src/lib/db.js";
import { getStubTransportForTests } from "../../src/lib/emails.js";
import type { DataExport } from "../../src/lib/data-export.js";

/**
 * Integration tests for the GDPR Art. 15 + Art. 20 self-service data export.
 *
 * Route under test:
 *   - POST /auth/me/export
 *
 * Posture mirrors the other re-auth endpoints (change-password / delete): the
 * session proves identity, the current password proves it is really the owner
 * behind a possibly-stolen cookie. A per-user frequency cap (5/hour) guards
 * the Art. 12(5) "manifestly excessive" case and the notification-email
 * amplification.
 */

let app: ReturnType<typeof buildApp>;

beforeAll(() => {
  app = buildApp();
});

const VALID_PASSWORD = "Hunter2!Bigger";
const DATA_EXPORTED_TEMPLATE_ID = "auth.data-exported";

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

async function seedPersonalCustomer(opts?: {
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
  return { id: user.id, email, cookie: await loginAndGetCookie(email) };
}

async function seedCorporateCustomer(): Promise<{
  id: string;
  email: string;
  cookie: string;
}> {
  const db = getDb();
  const email = "corp@example.com";
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
  if (!user) throw new Error("corp user seed failed");
  await db.insert(schema.corporateProfiles).values({
    userId: user.id,
    companyName: "Демо ЕООД",
    eik: "203456789",
    vatNumber: "BG203456789",
    registeredAddress: "ул. Тестова 1, София",
    mol: "Иван Иванов",
    contactName: "Петър Петров",
    contactPhone: "+359888111222",
  });
  return { id: user.id, email, cookie: await loginAndGetCookie(email) };
}

async function exportData(cookie: string, password = VALID_PASSWORD) {
  return app.request("/auth/me/export", {
    method: "POST",
    headers: cookieHeader(cookie),
    body: JSON.stringify({ currentPassword: password }),
  });
}

describe("POST /auth/me/export — re-auth and validation gates", () => {
  it("401s when there is no session", async () => {
    const res = await app.request("/auth/me/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: VALID_PASSWORD }),
    });
    expect(res.status).toBe(401);
  });

  it("400s when currentPassword is missing", async () => {
    const { cookie } = await seedPersonalCustomer();
    const res = await app.request("/auth/me/export", {
      method: "POST",
      headers: cookieHeader(cookie),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("400s on unknown keys (strict schema, defence in depth)", async () => {
    const { cookie } = await seedPersonalCustomer();
    const res = await app.request("/auth/me/export", {
      method: "POST",
      headers: cookieHeader(cookie),
      body: JSON.stringify({ currentPassword: VALID_PASSWORD, userId: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("401s on a wrong current password and records exactly one failed attempt", async () => {
    const { email, cookie } = await seedPersonalCustomer();
    const res = await exportData(cookie, "WrongPassword!1");
    expect(res.status).toBe(401);

    const db = getDb();
    const attempts = await db
      .select()
      .from(schema.loginAttempts)
      .where(eq(schema.loginAttempts.email, email));
    const failures = attempts.filter((a) => a.success === false);
    expect(failures).toHaveLength(1);
  });

  it("does not send a notification email on a failed re-auth", async () => {
    const { cookie } = await seedPersonalCustomer();
    await exportData(cookie, "WrongPassword!1");
    const sent = getStubTransportForTests().sent;
    const exportMails = sent.filter(
      (m) => m.templateId === DATA_EXPORTED_TEMPLATE_ID,
    );
    expect(exportMails).toHaveLength(0);
  });
});

describe("POST /auth/me/export — happy path and payload shape", () => {
  it("returns 200 with a downloadable, no-store JSON attachment", async () => {
    const { cookie } = await seedPersonalCustomer();
    const res = await exportData(cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-disposition")).toContain(".json");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("carries the account, Art. 20 portable data and Art. 15 metadata", async () => {
    const { email, cookie } = await seedPersonalCustomer();
    const res = await exportData(cookie);
    const body = (await res.json()) as DataExport;

    // Envelope advertises both legal bases.
    expect(body.export.format).toBe("application/json");
    expect(body.export.legalBasis.join(" ")).toContain("Article 15");
    expect(body.export.legalBasis.join(" ")).toContain("Article 20");

    // Account + profile (the data the subject provided).
    expect(body.account.email).toBe(email);
    expect(body.account.role).toBe("customer");
    expect(body.profile?.kind).toBe("personal");
    if (body.profile?.kind === "personal") {
      expect(body.profile.fullName).toBe("Иван Иванов");
      expect(body.profile.phone).toBe("+359888000000");
    }

    // Art. 15 transparency block.
    expect(body.processingInformation.purposes.length).toBeGreaterThan(0);
    expect(body.processingInformation.rights.length).toBeGreaterThan(0);
    expect(body.processingInformation.supervisoryAuthority.name).toContain(
      "КЗЛД",
    );
    expect(body.processingInformation.automatedDecisionMaking).toContain(
      "чл. 22",
    );

    // Security-activity summary present (raw rows are intentionally excluded).
    expect(typeof body.securityActivity.recordedLoginAttempts).toBe("number");
  });

  it("renders a corporate profile correctly", async () => {
    const { cookie } = await seedCorporateCustomer();
    const res = await exportData(cookie);
    const body = (await res.json()) as DataExport;
    expect(body.profile?.kind).toBe("corporate");
    if (body.profile?.kind === "corporate") {
      expect(body.profile.companyName).toBe("Демо ЕООД");
      expect(body.profile.eik).toBe("203456789");
      expect(body.profile.vatNumber).toBe("BG203456789");
    }
  });

  it("sends exactly one Bulgarian data-export notification on success", async () => {
    const { email, cookie } = await seedPersonalCustomer();
    await exportData(cookie);
    const sent = getStubTransportForTests().sent;
    const exportMails = sent.filter(
      (m) => m.templateId === DATA_EXPORTED_TEMPLATE_ID,
    );
    expect(exportMails).toHaveLength(1);
    expect(exportMails[0]?.to).toBe(email);
  });

  it("never leaks credentials or secret material in the payload", async () => {
    const { id, cookie } = await seedPersonalCustomer();
    // Capture the stored Argon2 hash so we can assert it never appears.
    const db = getDb();
    const [row] = await db
      .select({ passwordHash: schema.users.passwordHash })
      .from(schema.users)
      .where(eq(schema.users.id, id))
      .limit(1);
    const res = await exportData(cookie);
    const raw = await res.text();
    expect(raw).not.toContain(row!.passwordHash);
    expect(raw.toLowerCase()).not.toContain("passwordhash");
    expect(raw.toLowerCase()).not.toContain("password_hash");
    expect(raw.toLowerCase()).not.toContain("token_hash");
    expect(raw.toLowerCase()).not.toContain("mfa_secret");
  });
});

describe("POST /auth/me/export — includes the user's records", () => {
  it("includes address book, cart, and full order history", async () => {
    const { id, cookie } = await seedPersonalCustomer();
    const db = getDb();

    // Address book entry.
    await db.insert(schema.addresses).values({
      userId: id,
      label: "Вкъщи",
      city: "София",
      postalCode: "1000",
      street: "ул. Витоша 1",
      apartmentOrOffice: "ап. 5",
    });

    // A product + a cart with one line.
    const [product] = await db
      .insert(schema.products)
      .values({
        slug: "demo-thing",
        code: "DEMO-EXP-1",
        name: "Демо артикул",
        description: "",
        priceCents: "1999",
      })
      .returning();
    await db.insert(schema.carts).values({ userId: id });
    await db.insert(schema.cartItems).values({
      cartUserId: id,
      productId: product!.id,
      quantity: 2,
    });

    // An order with a line item, delivery snapshot and status history.
    const [order] = await db
      .insert(schema.orders)
      .values({
        orderNumber: "2026-05-00042",
        customerId: id,
        idempotencyKey: `test-${crypto.randomUUID()}`,
        status: "processing",
        paymentMethod: "cash_on_delivery",
        customerEmail: "buyer@example.com",
        customerPhone: "+359888000000",
        customerName: "Иван Иванов",
        subtotalCents: "3998",
        discountPercent: "0",
        discountAmountCents: "0",
        totalCents: "3998",
      })
      .returning();
    await db.insert(schema.orderItems).values({
      orderId: order!.id,
      productCode: "DEMO-EXP-1",
      productName: "Демо артикул",
      unitPriceCents: "1999",
      quantity: 2,
    });
    await db.insert(schema.orderDeliveryAddress).values({
      orderId: order!.id,
      city: "София",
      postalCode: "1000",
      street: "ул. Витоша 1",
      apartmentOrOffice: "ап. 5",
    });
    await db.insert(schema.orderStatusHistory).values({
      orderId: order!.id,
      status: "processing",
      note: "seed",
    });

    const res = await exportData(cookie);
    const body = (await res.json()) as DataExport;

    expect(body.addresses).toHaveLength(1);
    expect(body.addresses[0]?.city).toBe("София");

    expect(body.cart.items).toHaveLength(1);
    expect(body.cart.items[0]?.productName).toBe("Демо артикул");
    expect(body.cart.items[0]?.quantity).toBe(2);

    expect(body.orders).toHaveLength(1);
    const exported = body.orders[0];
    expect(exported?.orderNumber).toBe("2026-05-00042");
    expect(exported?.totalCents).toBe(3998);
    expect(exported?.items).toHaveLength(1);
    expect(exported?.items[0]?.productName).toBe("Демо артикул");
    expect(exported?.deliveryAddress?.street).toBe("ул. Витоша 1");
    expect(exported?.statusHistory.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty collections for a fresh account (no orders/addresses/cart)", async () => {
    const { cookie } = await seedPersonalCustomer();
    const res = await exportData(cookie);
    const body = (await res.json()) as DataExport;
    expect(body.orders).toEqual([]);
    expect(body.addresses).toEqual([]);
    expect(body.cart.items).toEqual([]);
    expect(body.accountDiscount).toBeNull();
    // No visitor cookie on this request ⇒ no consent receipts associated.
    expect(body.cookieConsents).toEqual([]);
  });

  it("includes the requesting browser's cookie-consent receipts (Art. 7)", async () => {
    const { cookie } = await seedPersonalCustomer();

    // Record a consent choice and capture the opaque visitor cookie the route
    // mints. The export re-associates receipts with the CURRENT browser by
    // reading this same cookie (see lib/data-export.ts + auth.ts).
    const consentRes = await app.request("/consent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ acceptedCategories: ["analytics"] }),
    });
    expect(consentRes.status).toBe(201);
    const vid = consentRes.headers
      .get("set-cookie")
      ?.match(new RegExp(`(?:^|;\\s*)${visitorCookieName()}=([^;]+)`))?.[1];
    expect(vid).toBeTruthy();

    // Export with BOTH the session cookie (identity) and the visitor cookie
    // (browser scope) on the request.
    const res = await app.request("/auth/me/export", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${sessionCookieName()}=${cookie}; ${visitorCookieName()}=${vid}`,
      },
      body: JSON.stringify({ currentPassword: VALID_PASSWORD }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DataExport;

    // The consent receipt for THIS browser is disclosed, and the export schema
    // version reflects the added section.
    expect(body.export.schemaVersion).toBe("1.1");
    expect(body.cookieConsents).toHaveLength(1);
    expect(body.cookieConsents[0]?.acceptedCategories).toEqual(["analytics"]);
    expect(Number.isNaN(Date.parse(body.cookieConsents[0]!.recordedAt))).toBe(
      false,
    );
  });
});

describe("POST /auth/me/export — frequency limit (Art. 12(5))", () => {
  it("allows 5 exports per window then 429s the 6th with the export problem type", async () => {
    const { cookie } = await seedPersonalCustomer();
    for (let i = 0; i < 5; i++) {
      const ok = await exportData(cookie);
      expect(ok.status).toBe(200);
    }
    const sixth = await exportData(cookie);
    expect(sixth.status).toBe(429);
    const problem = (await sixth.json()) as { type: string };
    expect(problem.type).toBe("/problems/export-rate-limited");
  });
});
