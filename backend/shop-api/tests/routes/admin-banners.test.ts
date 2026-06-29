import { hashPassword } from "@shop/auth";
import { schema } from "@shop/db";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { sessionCookieName } from "../../src/lib/cookies.js";
import { getDb } from "../../src/lib/db.js";
import { createSession } from "../../src/lib/sessions.js";

/**
 * Integration tests for the admin banner-management slice
 * (routes/admin/banners.ts): the requireAdmin gate, the list, create (append
 * ordering + internal-link validation + isActive default), update (toggle +
 * optimistic locking via updatedAt + FOR UPDATE), reorder (exact-set guard),
 * and the hard delete — plus the admin_audit_log entry. Exercised against the
 * live route + real Postgres.
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

type AdminBanner = {
  id: string;
  imageS3Key: string;
  imageUrl: string;
  title: string | null;
  subtitle: string | null;
  linkUrl: string | null;
  isActive: boolean;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
};

async function req(
  method: string,
  path: string,
  cookie: string,
  body?: unknown,
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: {
      Cookie: cookie,
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
  return app.request(path, init);
}

async function createBanner(
  cookie: string,
  body: Record<string, unknown>,
): Promise<AdminBanner> {
  const res = await req("POST", "/admin/banners", cookie, body);
  expect(res.status).toBe(201);
  return (await res.json()) as AdminBanner;
}

describe("admin banners — auth gate", () => {
  it("returns 404 (not 401/403) without an admin session", async () => {
    const res = await app.request("/admin/banners");
    expect(res.status).toBe(404);
  });

  it("returns 404 for a logged-in customer (no surface enumeration)", async () => {
    const cookie = await seedCustomerSession();
    const res = await req("GET", "/admin/banners", cookie);
    expect(res.status).toBe(404);
  });
});

describe("GET /admin/banners", () => {
  it("lists every slide (active + hidden) in display order", async () => {
    const cookie = await seedAdminSession();
    await createBanner(cookie, { imageS3Key: "banners/a.jpg", title: "А" });
    await createBanner(cookie, { imageS3Key: "banners/b.jpg", title: "Б", isActive: false });

    const res = await req("GET", "/admin/banners", cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: AdminBanner[] };
    expect(body.items.map((b) => b.title)).toEqual(["А", "Б"]);
    expect(body.items.map((b) => b.displayOrder)).toEqual([0, 1]);
    // Hidden slide is present in the ADMIN list (unlike the public read).
    expect(body.items[1]!.isActive).toBe(false);
  });
});

describe("POST /admin/banners", () => {
  it("creates a slide, defaults isActive=true, appends to the end", async () => {
    const cookie = await seedAdminSession();
    const first = await createBanner(cookie, { imageS3Key: "banners/a.jpg" });
    expect(first).toMatchObject({ isActive: true, displayOrder: 0, title: null });
    expect(first.imageUrl).toMatch(/^https?:\/\//);

    const second = await createBanner(cookie, {
      imageS3Key: "banners/b.jpg",
      title: "Втори",
      subtitle: "Описание",
      linkUrl: "/products/tools",
    });
    expect(second).toMatchObject({
      displayOrder: 1,
      title: "Втори",
      subtitle: "Описание",
      linkUrl: "/products/tools",
    });
  });

  it("rejects an off-site / unsafe link with a 400", async () => {
    const cookie = await seedAdminSession();
    const res = await req("POST", "/admin/banners", cookie, {
      imageS3Key: "banners/a.jpg",
      linkUrl: "https://evil.example",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors?: { path: string }[] };
    expect(body.errors?.some((e) => e.path === "linkUrl")).toBe(true);
  });

  it("requires an image key", async () => {
    const cookie = await seedAdminSession();
    const res = await req("POST", "/admin/banners", cookie, { title: "no image" });
    expect(res.status).toBe(400);
  });

  it("writes an admin_audit_log row", async () => {
    const cookie = await seedAdminSession();
    const created = await createBanner(cookie, { imageS3Key: "banners/a.jpg" });
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.adminAuditLog)
      .where(
        and(
          eq(schema.adminAuditLog.action, "banner.create"),
          eq(schema.adminAuditLog.entityId, created.id),
        ),
      );
    expect(rows.length).toBe(1);
    expect(rows[0]!.entityTable).toBe("banner_slides");
  });
});

describe("PATCH /admin/banners/:id", () => {
  it("toggles isActive without deleting", async () => {
    const cookie = await seedAdminSession();
    const b = await createBanner(cookie, { imageS3Key: "banners/a.jpg" });
    const res = await req("PATCH", `/admin/banners/${b.id}`, cookie, {
      expectedUpdatedAt: b.updatedAt,
      isActive: false,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as AdminBanner).isActive).toBe(false);
  });

  it("409s on a stale optimistic-lock token", async () => {
    const cookie = await seedAdminSession();
    const b = await createBanner(cookie, { imageS3Key: "banners/a.jpg" });
    // First edit succeeds and bumps updatedAt.
    const ok = await req("PATCH", `/admin/banners/${b.id}`, cookie, {
      expectedUpdatedAt: b.updatedAt,
      title: "Ново заглавие",
    });
    expect(ok.status).toBe(200);
    // Second edit with the ORIGINAL token is stale.
    const stale = await req("PATCH", `/admin/banners/${b.id}`, cookie, {
      expectedUpdatedAt: b.updatedAt,
      title: "Пак ново",
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { type: string }).type).toBe(
      "/problems/banner-version-conflict",
    );
  });

  it("404s for an unknown id", async () => {
    const cookie = await seedAdminSession();
    const res = await req(
      "PATCH",
      "/admin/banners/00000000-0000-0000-0000-000000000000",
      cookie,
      { expectedUpdatedAt: new Date().toISOString(), isActive: false },
    );
    expect(res.status).toBe(404);
  });

  it("rejects a bad link on update with a 400", async () => {
    const cookie = await seedAdminSession();
    const b = await createBanner(cookie, { imageS3Key: "banners/a.jpg" });
    const res = await req("PATCH", `/admin/banners/${b.id}`, cookie, {
      expectedUpdatedAt: b.updatedAt,
      linkUrl: "//evil.example",
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /admin/banners/reorder", () => {
  it("rewrites display order to the supplied sequence", async () => {
    const cookie = await seedAdminSession();
    const a = await createBanner(cookie, { imageS3Key: "banners/a.jpg", title: "А" });
    const b = await createBanner(cookie, { imageS3Key: "banners/b.jpg", title: "Б" });
    const c = await createBanner(cookie, { imageS3Key: "banners/c.jpg", title: "В" });

    const res = await req("POST", "/admin/banners/reorder", cookie, {
      orderedIds: [c.id, a.id, b.id],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: AdminBanner[] };
    expect(body.items.map((x) => x.title)).toEqual(["В", "А", "Б"]);
    expect(body.items.map((x) => x.displayOrder)).toEqual([0, 1, 2]);
  });

  it("409s when the id set does not match the current slides", async () => {
    const cookie = await seedAdminSession();
    const a = await createBanner(cookie, { imageS3Key: "banners/a.jpg" });
    await createBanner(cookie, { imageS3Key: "banners/b.jpg" });
    // Missing one of the two ids.
    const res = await req("POST", "/admin/banners/reorder", cookie, {
      orderedIds: [a.id],
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { type: string }).type).toBe(
      "/problems/banner-reorder-mismatch",
    );
  });
});

describe("DELETE /admin/banners/:id", () => {
  it("hard-deletes a slide", async () => {
    const cookie = await seedAdminSession();
    const b = await createBanner(cookie, { imageS3Key: "banners/a.jpg" });
    const res = await req("DELETE", `/admin/banners/${b.id}`, cookie, {
      expectedUpdatedAt: b.updatedAt,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });

    const list = await req("GET", "/admin/banners", cookie);
    expect(((await list.json()) as { items: unknown[] }).items).toEqual([]);
  });

  it("409s on a stale token (no deletion)", async () => {
    const cookie = await seedAdminSession();
    const b = await createBanner(cookie, { imageS3Key: "banners/a.jpg" });
    await req("PATCH", `/admin/banners/${b.id}`, cookie, {
      expectedUpdatedAt: b.updatedAt,
      title: "Edited",
    });
    const res = await req("DELETE", `/admin/banners/${b.id}`, cookie, {
      expectedUpdatedAt: b.updatedAt,
    });
    expect(res.status).toBe(409);
  });

  it("404s for an unknown id", async () => {
    const cookie = await seedAdminSession();
    const res = await req(
      "DELETE",
      "/admin/banners/00000000-0000-0000-0000-000000000000",
      cookie,
      { expectedUpdatedAt: new Date().toISOString() },
    );
    expect(res.status).toBe(404);
  });
});
