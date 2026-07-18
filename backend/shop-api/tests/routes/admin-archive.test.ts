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

// ─── Snapshot restore (roadmap item 52) ───────────────────────────────────────

const SNAP_T = "2026-06-01T03:00:00.000Z";

function snapCat(o: {
  id: string;
  slug: string;
  name?: string;
  parentId?: string | null;
  deletedAt?: string | null;
}) {
  return {
    id: o.id,
    slug: o.slug,
    name: o.name ?? o.slug,
    parentId: o.parentId ?? null,
    imageS3Key: null,
    displayOrder: 0,
    deletedAt: o.deletedAt ?? null,
    createdAt: SNAP_T,
    updatedAt: SNAP_T,
  };
}

function snapProd(o: {
  id: string;
  slug: string;
  code: string;
  name?: string;
  categoryId?: string | null;
  deletedAt?: string | null;
}) {
  return {
    id: o.id,
    slug: o.slug,
    code: o.code,
    name: o.name ?? o.slug,
    description: "",
    priceCents: "1999",
    currency: "EUR",
    categoryId: o.categoryId ?? null,
    stockStatus: "in_stock" as const,
    newUntil: null,
    displayOrder: 0,
    deletedAt: o.deletedAt ?? null,
    createdAt: SNAP_T,
    updatedAt: SNAP_T,
  };
}

function snapshotJson(tables: {
  categories?: ReturnType<typeof snapCat>[];
  products?: ReturnType<typeof snapProd>[];
  productImages?: unknown[];
  bannerSlides?: unknown[];
}): string {
  const t = {
    categories: tables.categories ?? [],
    products: tables.products ?? [],
    productImages: tables.productImages ?? [],
    bannerSlides: tables.bannerSlides ?? [],
  };
  return JSON.stringify({
    v: 1,
    kind: "catalog-backup",
    takenAt: SNAP_T,
    counts: {
      categories: t.categories.length,
      products: t.products.length,
      productImages: t.productImages.length,
      bannerSlides: t.bannerSlides.length,
    },
    tables: t,
  });
}

/** Inject a fixed snapshot body for the S3 read (keeps the fake backup runner). */
function setSnapshot(json: string): void {
  _setArchiveAdaptersForTests({ getObject: async () => json });
}

async function insertBackup(
  s3Key: string,
  kind: "manual" | "scheduled" = "scheduled",
): Promise<string> {
  const db = getDb();
  const [row] = await db
    .insert(schema.catalogBackups)
    .values({ s3Key, kind, sizeBytes: "1024" })
    .returning({ id: schema.catalogBackups.id });
  if (!row) throw new Error("backup seed failed");
  return row.id;
}

async function runPreview(backupId: string, cookie = adminCookie) {
  return app.request(`/admin/archive/backups/${backupId}/preview`, {
    headers: { cookie, Accept: "application/json" },
  });
}

async function runRestore(backupId: string, confirm: string, cookie = adminCookie) {
  return app.request(`/admin/archive/backups/${backupId}/restore`, {
    method: "POST",
    headers: {
      cookie,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ confirm }),
  });
}

describe("snapshot restore — auth gate", () => {
  it("blocks a customer from previewing a restore", async () => {
    setBackupBucket("test-bucket");
    const backupId = await insertBackup("catalog/x.json");
    const res = await runPreview(backupId, customerCookie);
    expect(res.status).toBe(404);
  });

  it("blocks a customer from running a restore", async () => {
    setBackupBucket("test-bucket");
    const backupId = await insertBackup("catalog/x.json");
    const res = await runRestore(backupId, "ВЪЗСТАНОВИ", customerCookie);
    expect(res.status).toBe(404);
  });
});

describe("GET /admin/archive/backups/:id/preview", () => {
  it("returns the plan: snapshot counts + the live rows it would archive", async () => {
    setBackupBucket("test-bucket");
    const catSlug = uniq("cat");
    const catId = await insertCategory({ slug: catSlug, name: "Кат" });
    const p1Slug = uniq("p1");
    const p1Code = uniq("P1").toUpperCase();
    const p1 = await insertProduct({
      name: "Keep",
      slug: p1Slug,
      code: p1Code,
      categoryId: catId,
    });
    await insertProduct({ name: "По-нов продукт", categoryId: catId }); // newer, absent from snapshot

    setSnapshot(
      snapshotJson({
        categories: [snapCat({ id: catId, slug: catSlug, name: "Кат" })],
        products: [snapProd({ id: p1, slug: p1Slug, code: p1Code, name: "Keep", categoryId: catId })],
      }),
    );
    const backupId = await insertBackup("catalog/prev.json");

    const res = await runPreview(backupId);
    expect(res.status).toBe(200);
    const plan = (await res.json()) as {
      counts: { products: number; categories: number };
      willArchive: { productCount: number; productNames: string[] };
    };
    expect(plan.counts.products).toBe(1);
    expect(plan.counts.categories).toBe(1);
    expect(plan.willArchive.productCount).toBe(1);
    expect(plan.willArchive.productNames).toContain("По-нов продукт");
  });

  it("returns 503 when no backup bucket is configured", async () => {
    const backupId = await insertBackup("catalog/x.json"); // bucket left unset
    const res = await runPreview(backupId);
    expect(res.status).toBe(503);
  });

  it("returns 404 for an unknown backup id", async () => {
    setBackupBucket("test-bucket");
    const res = await runPreview(randomUUID());
    expect(res.status).toBe(404);
    const body = (await res.json()) as { type: string };
    expect(body.type).toBe("/problems/backup-not-found");
  });

  it("returns 422 for a malformed snapshot object", async () => {
    setBackupBucket("test-bucket");
    setSnapshot("this is not json");
    const backupId = await insertBackup("catalog/bad.json");
    const res = await runPreview(backupId);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { type: string };
    expect(body.type).toBe("/problems/snapshot-invalid");
  });
});

describe("POST /admin/archive/backups/:id/restore", () => {
  it("reverts edits, un-archives, archives newer rows, clears live redirects, audits", async () => {
    setBackupBucket("test-bucket");
    const db = getDb();

    const catSlug = uniq("cat");
    const p1Slug = uniq("p1");
    const p1Code = uniq("P1").toUpperCase();
    const p3Slug = uniq("p3");
    const p3Code = uniq("P3").toUpperCase();

    const catId = await insertCategory({ slug: catSlug, name: "Категория" });
    // P1 is edited live; the snapshot carries its ORIGINAL name.
    const p1 = await insertProduct({
      name: "Edited Name",
      slug: p1Slug,
      code: p1Code,
      categoryId: catId,
    });
    // P3 is archived live; the snapshot has it live (deletedAt null) → un-archive.
    const p3 = await insertProduct({
      name: "Продукт 3",
      slug: p3Slug,
      code: p3Code,
      categoryId: catId,
      deletedAt: new Date(),
    });
    // P2 was created AFTER the snapshot → the restore archives it.
    const p2 = await insertProduct({ name: "По-нов продукт", categoryId: catId });

    // A stale 301 at P3's URL that must be cleared once P3 is live again.
    const p3Path = `/products/${catSlug}/${p3Slug}`;
    await db.insert(schema.redirects).values({
      sourcePath: p3Path,
      targetKind: "home",
      targetCategoryId: null,
    });

    setSnapshot(
      snapshotJson({
        categories: [snapCat({ id: catId, slug: catSlug, name: "Категория" })],
        products: [
          snapProd({ id: p1, slug: p1Slug, code: p1Code, name: "Original Name", categoryId: catId }),
          snapProd({ id: p3, slug: p3Slug, code: p3Code, name: "Продукт 3", categoryId: catId, deletedAt: null }),
        ],
      }),
    );
    const backupId = await insertBackup("catalog/2026-06-01.json", "scheduled");

    const res = await runRestore(backupId, "ВЪЗСТАНОВИ");
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      restored: { willArchive: { productCount: number } };
      safetyBackupId: string;
    };
    expect(body.restored.willArchive.productCount).toBe(1);
    expect(body.safetyBackupId).toBeTruthy();

    const [rp1] = await db.select().from(schema.products).where(eq(schema.products.id, p1));
    expect(rp1!.name).toBe("Original Name"); // edit reverted
    expect(rp1!.deletedAt).toBeNull();
    const [rp3] = await db.select().from(schema.products).where(eq(schema.products.id, p3));
    expect(rp3!.deletedAt).toBeNull(); // un-archived
    const [rp2] = await db.select().from(schema.products).where(eq(schema.products.id, p2));
    expect(rp2!.deletedAt).not.toBeNull(); // newer → archived

    const reds = await db
      .select()
      .from(schema.redirects)
      .where(eq(schema.redirects.sourcePath, p3Path));
    expect(reds).toHaveLength(0); // live URL no longer 301s

    // The pre-restore safety backup exists (a manual snapshot).
    const manual = await db
      .select()
      .from(schema.catalogBackups)
      .where(eq(schema.catalogBackups.kind, "manual"));
    expect(manual.length).toBeGreaterThanOrEqual(1);

    // The restore is audited (GDPR Art. 30).
    const audit = await db
      .select()
      .from(schema.adminAuditLog)
      .where(eq(schema.adminAuditLog.action, "catalog.restore"));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.entityTable).toBe("catalog_backups");
  });

  it("returns 400 when the confirmation phrase is wrong (before any write)", async () => {
    setBackupBucket("test-bucket");
    setSnapshot(snapshotJson({}));
    const backupId = await insertBackup("catalog/x.json");
    const res = await runRestore(backupId, "нещо");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { type: string };
    expect(body.type).toBe("/problems/restore-confirmation-required");

    // Nothing was written — no manual (safety) backup taken.
    const db = getDb();
    const manual = await db
      .select()
      .from(schema.catalogBackups)
      .where(eq(schema.catalogBackups.kind, "manual"));
    expect(manual).toHaveLength(0);
  });

  it("returns 503 when no backup bucket is configured", async () => {
    const backupId = await insertBackup("catalog/x.json");
    const res = await runRestore(backupId, "ВЪЗСТАНОВИ");
    expect(res.status).toBe(503);
  });

  it("returns 404 for an unknown backup id", async () => {
    setBackupBucket("test-bucket");
    const res = await runRestore(randomUUID(), "ВЪЗСТАНОВИ");
    expect(res.status).toBe(404);
  });

  it("returns 422 for a malformed snapshot, before taking a safety backup", async () => {
    setBackupBucket("test-bucket");
    setSnapshot("{ not valid json");
    const backupId = await insertBackup("catalog/bad.json");
    const res = await runRestore(backupId, "ВЪЗСТАНОВИ");
    expect(res.status).toBe(422);

    const db = getDb();
    const manual = await db
      .select()
      .from(schema.catalogBackups)
      .where(eq(schema.catalogBackups.kind, "manual"));
    expect(manual).toHaveLength(0); // aborted before the safety backup
  });
});
