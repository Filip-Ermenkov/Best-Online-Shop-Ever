import { randomUUID } from "node:crypto";
import { hashPassword } from "@shop/auth";
import { schema } from "@shop/db";
import { and, eq } from "drizzle-orm";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { buildApp } from "../../src/app.js";
import { sessionCookieName } from "../../src/lib/cookies.js";
import { getDb } from "../../src/lib/db.js";
import { _resetEnvForTests } from "../../src/lib/env.js";
import { createSession } from "../../src/lib/sessions.js";
import type { CatalogBackupResult } from "../../src/jobs/catalog-backup.js";
import {
  _resetArchiveAdaptersForTests,
  _setArchiveAdaptersForTests,
  type ArchiveOverview,
  type BackupRunnerFn,
} from "../../src/routes/admin/archive.js";

/**
 * Integration tests for the admin archive slice (routes/admin/archive.ts +
 * the new POST /admin/categories/:id/restore): the requireAdmin gate, the
 * overview (soft-deleted products + categories + backups list + availability),
 * the manual on-demand backup (happy path via an injected runner, the 503 when
 * unconfigured, the 502 on runner failure, and the audit row), and category
 * restore (un-archive + redirect clear + orphan re-home + slug-collision 409 +
 * the not-archived 404). Exercised against the live route + real Postgres. The
 * S3 write is injected — the real backup is proven by the catalog-backup job suite.
 */

let app: ReturnType<typeof buildApp>;
const PASSWORD = "correct horse battery staple";

const RUN = Date.now().toString(36);
let seq = 0;
const uniq = (base: string) => `${base}-${RUN}-${++seq}`;

/** A fake backup runner that writes the catalog_backups row the route reads back. */
const fakeBackupRunner: BackupRunnerFn = async (opts): Promise<CatalogBackupResult> => {
  const db = getDb();
  const key = `catalog/manual/${uniq("run")}.json`;
  await db.insert(schema.catalogBackups).values({
    s3Key: key,
    kind: "manual",
    triggeredByUserId: opts.triggeredByUserId,
    sizeBytes: "512",
  });
  return {
    bucket: "test-bucket",
    key,
    bytes: 512,
    kind: "manual",
    counts: { categories: 0, products: 0, productImages: 0, bannerSlides: 0 },
  };
};

function cookieHeader(token: string): string {
  return `${sessionCookieName()}=${token}`;
}

function setBackupBucket(value: string): void {
  process.env.CATALOG_BACKUP_BUCKET = value;
  _resetEnvForTests();
}

async function seedSession(role: "admin" | "customer", email: string): Promise<string> {
  const db = getDb();
  const [user] = await db
    .insert(schema.users)
    .values({
      email: email.toLowerCase(),
      passwordHash: await hashPassword(PASSWORD),
      role,
      accountType: role === "customer" ? "personal" : null,
      emailVerifiedAt: new Date(),
      mfaEnabled: role === "admin",
    })
    .returning();
  if (!user) throw new Error("session seed failed");
  const { token } = await createSession({
    userId: user.id,
    rememberMe: false,
    role,
    ipAddress: null,
    userAgent: null,
  });
  return cookieHeader(token);
}

async function insertCategory(opts: {
  slug: string;
  name?: string;
  parentId?: string | null;
  deletedAt?: Date | null;
}): Promise<string> {
  const db = getDb();
  const [row] = await db
    .insert(schema.categories)
    .values({
      slug: opts.slug,
      name: opts.name ?? opts.slug,
      parentId: opts.parentId ?? null,
      displayOrder: 0,
      deletedAt: opts.deletedAt ?? null,
    })
    .returning({ id: schema.categories.id });
  if (!row) throw new Error("category seed failed");
  return row.id;
}

async function insertProduct(opts: {
  name: string;
  code?: string;
  slug?: string;
  categoryId?: string | null;
  deletedAt?: Date | null;
}): Promise<string> {
  const db = getDb();
  const [row] = await db
    .insert(schema.products)
    .values({
      name: opts.name,
      code: opts.code ?? uniq("SKU").toUpperCase(),
      slug: opts.slug ?? uniq("p"),
      priceCents: "1999",
      categoryId: opts.categoryId ?? null,
      deletedAt: opts.deletedAt ?? null,
    })
    .returning({ id: schema.products.id });
  if (!row) throw new Error("product seed failed");
  return row.id;
}

async function getArchive(cookie: string) {
  const res = await app.request("/admin/archive", {
    headers: { cookie, Accept: "application/json" },
  });
  const body = res.ok ? ((await res.json()) as ArchiveOverview) : null;
  return { res, body };
}

let adminCookie: string;
let customerCookie: string;

beforeAll(() => {
  app = buildApp();
});

beforeEach(async () => {
  adminCookie = await seedSession("admin", `admin-${RUN}@shop.bg`);
  customerCookie = await seedSession("customer", `cust-${RUN}@example.com`);
  _setArchiveAdaptersForTests({ backupRunner: fakeBackupRunner });
  setBackupBucket(""); // default unconfigured; tests opt in
});

afterEach(() => {
  _resetArchiveAdaptersForTests();
  delete process.env.CATALOG_BACKUP_BUCKET;
  _resetEnvForTests();
});

// ─── Auth gate ────────────────────────────────────────────────────────────────

describe("admin archive — auth gate", () => {
  it("returns 404 with no session", async () => {
    const res = await app.request("/admin/archive");
    expect(res.status).toBe(404);
  });

  it("returns 404 for a signed-in customer", async () => {
    const res = await app.request("/admin/archive", {
      headers: { cookie: customerCookie },
    });
    expect(res.status).toBe(404);
  });

  it("blocks a customer from triggering a manual backup", async () => {
    setBackupBucket("test-bucket");
    const res = await app.request("/admin/archive/backup", {
      method: "POST",
      headers: { cookie: customerCookie },
    });
    expect(res.status).toBe(404);
  });
});

// ─── Overview ─────────────────────────────────────────────────────────────────

describe("GET /admin/archive — overview", () => {
  it("returns empty lists and backupsAvailable=false when unconfigured", async () => {
    const { res, body } = await getArchive(adminCookie);
    expect(res.status).toBe(200);
    expect(body!.archivedProducts).toEqual([]);
    expect(body!.archivedCategories).toEqual([]);
    expect(body!.backups).toEqual([]);
    expect(body!.backupsAvailable).toBe(false);
  });

  it("lists only soft-deleted products, with their category name", async () => {
    const catId = await insertCategory({ slug: uniq("cat"), name: "Обувки" });
    await insertProduct({ name: "Жив продукт", categoryId: catId }); // live — excluded
    await insertProduct({
      name: "Архивиран продукт",
      code: "ARCH-1",
      categoryId: catId,
      deletedAt: new Date(),
    });

    const { body } = await getArchive(adminCookie);
    expect(body!.archivedProducts).toHaveLength(1);
    const p = body!.archivedProducts[0]!;
    expect(p.name).toBe("Архивиран продукт");
    expect(p.code).toBe("ARCH-1");
    expect(p.categoryName).toBe("Обувки");
    expect(typeof p.deletedAt).toBe("string");
  });

  it("lists only soft-deleted categories, with their parent name", async () => {
    const parentId = await insertCategory({ slug: uniq("parent"), name: "Родител" });
    await insertCategory({ slug: uniq("live"), name: "Жива" }); // live — excluded
    await insertCategory({
      slug: uniq("gone"),
      name: "Изтрита",
      parentId,
      deletedAt: new Date(),
    });

    const { body } = await getArchive(adminCookie);
    expect(body!.archivedCategories).toHaveLength(1);
    const c = body!.archivedCategories[0]!;
    expect(c.name).toBe("Изтрита");
    expect(c.parentName).toBe("Родител");
  });

  it("lists catalog backups newest-first with kind + numeric size", async () => {
    const db = getDb();
    await db.insert(schema.catalogBackups).values([
      {
        s3Key: "catalog/2026-07-01.json",
        kind: "scheduled",
        sizeBytes: "2048",
        createdAt: new Date("2026-07-01T03:00:00Z"),
      },
      {
        s3Key: "catalog/manual/2026-07-05_10-00-00.json",
        kind: "manual",
        sizeBytes: null,
        createdAt: new Date("2026-07-05T10:00:00Z"),
      },
    ]);

    const { body } = await getArchive(adminCookie);
    expect(body!.backups).toHaveLength(2);
    expect(body!.backups[0]!.kind).toBe("manual"); // newest first
    expect(body!.backups[0]!.sizeBytes).toBeNull();
    expect(body!.backups[1]!.kind).toBe("scheduled");
    expect(body!.backups[1]!.sizeBytes).toBe(2048); // text → number
  });

  it("reports backupsAvailable=true when a bucket is configured", async () => {
    setBackupBucket("test-bucket");
    const { body } = await getArchive(adminCookie);
    expect(body!.backupsAvailable).toBe(true);
  });
});

// ─── Manual backup ──────────────────────────────────────────────────────────

describe("POST /admin/archive/backup — manual backup", () => {
  it("writes a manual snapshot + an audit row and returns 201", async () => {
    setBackupBucket("test-bucket");
    const res = await app.request("/admin/archive/backup", {
      method: "POST",
      headers: { cookie: adminCookie },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { kind: string; sizeBytes: number; id: string };
    expect(body.kind).toBe("manual");
    expect(body.sizeBytes).toBe(512);

    const db = getDb();
    const backups = await db.select().from(schema.catalogBackups);
    expect(backups).toHaveLength(1);
    expect(backups[0]!.kind).toBe("manual");

    const audits = await db
      .select()
      .from(schema.adminAuditLog)
      .where(eq(schema.adminAuditLog.action, "backup.create"));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.entityTable).toBe("catalog_backups");
  });

  it("returns 503 when no backup bucket is configured", async () => {
    const res = await app.request("/admin/archive/backup", {
      method: "POST",
      headers: { cookie: adminCookie },
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { type: string };
    expect(body.type).toBe("/problems/backups-not-configured");
  });

  it("returns 502 when the backup runner throws", async () => {
    setBackupBucket("test-bucket");
    _setArchiveAdaptersForTests({
      backupRunner: async () => {
        throw new Error("S3 unavailable");
      },
    });
    const res = await app.request("/admin/archive/backup", {
      method: "POST",
      headers: { cookie: adminCookie },
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { type: string };
    expect(body.type).toBe("/problems/backup-failed");
  });
});

// ─── Category restore ─────────────────────────────────────────────────────────

describe("POST /admin/categories/:id/restore", () => {
  async function restore(id: string, cookie = adminCookie) {
    return app.request(`/admin/categories/${id}/restore`, {
      method: "POST",
      headers: { cookie, Accept: "application/json" },
    });
  }

  it("un-archives a soft-deleted category and clears its redirect", async () => {
    const db = getDb();
    const id = await insertCategory({
      slug: "obuvki",
      name: "Обувки",
      deletedAt: new Date(),
    });
    // The delete would have written this 301 for the category's URL.
    await db.insert(schema.redirects).values({
      sourcePath: "/products/obuvki",
      targetKind: "home",
      targetCategoryId: null,
    });

    const res = await restore(id);
    expect(res.status).toBe(200);

    const [row] = await db
      .select()
      .from(schema.categories)
      .where(eq(schema.categories.id, id));
    expect(row!.deletedAt).toBeNull();

    const redirects = await db
      .select()
      .from(schema.redirects)
      .where(eq(schema.redirects.sourcePath, "/products/obuvki"));
    expect(redirects).toHaveLength(0);
  });

  it("re-homes an orphan to root when its parent is still deleted", async () => {
    const db = getDb();
    const parentId = await insertCategory({
      slug: uniq("p"),
      name: "Родител",
      deletedAt: new Date(),
    });
    const childId = await insertCategory({
      slug: uniq("c"),
      name: "Дете",
      parentId,
      deletedAt: new Date(),
    });

    const res = await restore(childId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rehomed: boolean; parentId: string | null };
    expect(body.rehomed).toBe(true);
    expect(body.parentId).toBeNull();

    const [row] = await db
      .select()
      .from(schema.categories)
      .where(eq(schema.categories.id, childId));
    expect(row!.deletedAt).toBeNull();
    expect(row!.parentId).toBeNull();
  });

  it("returns 409 when a live category now holds the slug", async () => {
    const archivedId = await insertCategory({
      slug: "dup",
      name: "Стара",
      deletedAt: new Date(),
    });
    await insertCategory({ slug: "dup", name: "Нова (жива)" }); // live, same (root, slug)

    const res = await restore(archivedId);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { type: string };
    expect(body.type).toBe("/problems/category-restore-conflict");
  });

  it("returns 404 for a category that is not archived", async () => {
    const liveId = await insertCategory({ slug: uniq("live"), name: "Жива" });
    const res = await restore(liveId);
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown id", async () => {
    const res = await restore(randomUUID());
    expect(res.status).toBe(404);
  });
});
