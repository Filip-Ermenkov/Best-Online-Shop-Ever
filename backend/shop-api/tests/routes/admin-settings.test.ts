import { hashPassword } from "@shop/auth";
import { schema } from "@shop/db";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { sessionCookieName } from "../../src/lib/cookies.js";
import { getDb } from "../../src/lib/db.js";
import { createSession } from "../../src/lib/sessions.js";

/**
 * Integration tests for the admin store-settings slice (routes/admin/settings.ts):
 * the requireAdmin gate, GET (all values + version), PATCH (single + multi-key),
 * per-key validation (unknown key + bad value → 400), the empty-patch 400, the
 * document-level optimistic lock (stale version → 409), and the admin_audit_log
 * entry. Exercised against the live route + real Postgres.
 */

let app: ReturnType<typeof buildApp>;

beforeAll(() => {
  app = buildApp();
});

const PASSWORD = "correct horse battery staple";

function cookieHeader(token: string): string {
  return `${sessionCookieName()}=${token}`;
}

async function seedAdminSession(email = "admin@shop.bg"): Promise<string> {
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
  return cookieHeader(token);
}

async function seedCustomerSession(email = "ivan@example.com"): Promise<string> {
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
  return cookieHeader(token);
}

type AdminSettingsBody = {
  values: {
    default_pickup_deadline_days: number;
    store_address: string;
    store_hours: string;
    store_phone: string;
    store_email: string;
    admin_notification_email: string;
  };
  version: string;
};

function getJson(cookie: string) {
  return app.request("/admin/settings", {
    headers: { Cookie: cookie, Accept: "application/json" },
  });
}

function patchJson(cookie: string, body: unknown) {
  return app.request("/admin/settings", {
    method: "PATCH",
    headers: {
      Cookie: cookie,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("requireAdmin gate", () => {
  it("returns 404 with no session", async () => {
    const res = await app.request("/admin/settings");
    expect(res.status).toBe(404);
  });

  it("returns 404 for a customer session (no enumeration)", async () => {
    const cookie = await seedCustomerSession();
    const res = await getJson(cookie);
    expect(res.status).toBe(404);
  });
});

describe("GET /admin/settings", () => {
  it("returns all six keys (defaults) + an epoch version when unset", async () => {
    const cookie = await seedAdminSession();
    const res = await getJson(cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as AdminSettingsBody;
    expect(Object.keys(body.values).sort()).toEqual(
      [
        "admin_notification_email",
        "default_pickup_deadline_days",
        "store_address",
        "store_email",
        "store_hours",
        "store_phone",
      ].sort(),
    );
    expect(body.values.default_pickup_deadline_days).toBe(7);
    expect(body.values.store_phone).toBe("");
    expect(body.version).toBe(new Date(0).toISOString());
  });
});

describe("PATCH /admin/settings", () => {
  it("updates a single key, advances the version, and writes an audit row", async () => {
    const cookie = await seedAdminSession();
    const before = (await (await getJson(cookie)).json()) as AdminSettingsBody;

    const res = await patchJson(cookie, {
      expectedVersion: before.version,
      values: { store_phone: "  +359 2 900 1234  " },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AdminSettingsBody;
    // Trimmed + normalised on write.
    expect(body.values.store_phone).toBe("+359 2 900 1234");
    expect(body.version).not.toBe(before.version);

    const db = getDb();
    const audit = await db
      .select()
      .from(schema.adminAuditLog)
      .where(eq(schema.adminAuditLog.action, "settings.update"));
    expect(audit.length).toBe(1);
    expect(audit[0]!.entityTable).toBe("settings");
  });

  it("updates multiple keys at once", async () => {
    const cookie = await seedAdminSession();
    const before = (await (await getJson(cookie)).json()) as AdminSettingsBody;
    const res = await patchJson(cookie, {
      expectedVersion: before.version,
      values: {
        store_address: "ул. Тест 1",
        default_pickup_deadline_days: 10,
        store_email: "info@duda1.shop",
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AdminSettingsBody;
    expect(body.values.store_address).toBe("ул. Тест 1");
    expect(body.values.default_pickup_deadline_days).toBe(10);
    expect(body.values.store_email).toBe("info@duda1.shop");
  });

  it("rejects an unknown key with 400", async () => {
    const cookie = await seedAdminSession();
    const before = (await (await getJson(cookie)).json()) as AdminSettingsBody;
    const res = await patchJson(cookie, {
      expectedVersion: before.version,
      values: { evil_key: "x" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid value with 400 (bad email, out-of-range days)", async () => {
    const cookie = await seedAdminSession();
    const before = (await (await getJson(cookie)).json()) as AdminSettingsBody;

    const badEmail = await patchJson(cookie, {
      expectedVersion: before.version,
      values: { store_email: "not-an-email" },
    });
    expect(badEmail.status).toBe(400);

    const badDays = await patchJson(cookie, {
      expectedVersion: before.version,
      values: { default_pickup_deadline_days: 0 },
    });
    expect(badDays.status).toBe(400);
  });

  it("rejects an empty patch with 400", async () => {
    const cookie = await seedAdminSession();
    const before = (await (await getJson(cookie)).json()) as AdminSettingsBody;
    const res = await patchJson(cookie, {
      expectedVersion: before.version,
      values: {},
    });
    expect(res.status).toBe(400);
  });

  it("409s on a stale version (optimistic lock)", async () => {
    const cookie = await seedAdminSession();
    const before = (await (await getJson(cookie)).json()) as AdminSettingsBody;

    // First write succeeds and advances the version.
    const first = await patchJson(cookie, {
      expectedVersion: before.version,
      values: { store_phone: "+359 2 900 1111" },
    });
    expect(first.status).toBe(200);

    // Second write using the ORIGINAL (now stale) version must conflict.
    const second = await patchJson(cookie, {
      expectedVersion: before.version,
      values: { store_phone: "+359 2 900 2222" },
    });
    expect(second.status).toBe(409);
    const problem = (await second.json()) as { type?: string };
    expect(problem.type).toBe("/problems/settings-version-conflict");
  });

  it("400s on a non-timestamp expectedVersion", async () => {
    const cookie = await seedAdminSession();
    const res = await patchJson(cookie, {
      expectedVersion: "not-a-date",
      values: { store_phone: "+359 2 900 1234" },
    });
    expect(res.status).toBe(400);
  });
});
