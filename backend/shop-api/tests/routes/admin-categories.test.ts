import { hashPassword } from "@shop/auth";
import { schema } from "@shop/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { sessionCookieName } from "../../src/lib/cookies.js";
import { getDb } from "../../src/lib/db.js";
import { createSession } from "../../src/lib/sessions.js";

/**
 * Integration tests for the admin category-management slice
 * (routes/admin/categories.ts): the requireAdmin gate, the tree list with
 * per-node counts, create (slug rules + append ordering), update/move
 * (cycle prevention + optimistic locking via updatedAt + FOR UPDATE), sibling
 * reorder, the deletion-impact preview, and the cascade soft-delete that
 * writes 301 redirect rows + the admin_audit_log entry. Exercised against the
 * live route + real Postgres so middleware order, transactions, and the
 * Bulgarian→Latin slug fallback are all under test.
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

type CategoryRow = typeof schema.categories.$inferSelect;

async function insertCategory(opts: {
  name: string;
  slug: string;
  parentId?: string | null;
  displayOrder?: number;
  imageS3Key?: string | null;
}): Promise<CategoryRow> {
  const db = getDb();
  const [row] = await db
    .insert(schema.categories)
    .values({
      name: opts.name,
      slug: opts.slug,
      parentId: opts.parentId ?? null,
      displayOrder: opts.displayOrder ?? 0,
      imageS3Key: opts.imageS3Key ?? null,
    })
    .returning();
  if (!row) throw new Error("category seed failed");
  return row;
}

async function insertProduct(opts: {
  slug: string;
  code: string;
  name: string;
  categoryId: string | null;
  priceCents?: string;
}): Promise<string> {
  const db = getDb();
  const [row] = await db
    .insert(schema.products)
    .values({
      slug: opts.slug,
      code: opts.code,
      name: opts.name,
      categoryId: opts.categoryId,
      priceCents: opts.priceCents ?? "1999",
    })
    .returning({ id: schema.products.id });
  if (!row) throw new Error("product seed failed");
  return row.id;
}

let orderSeq = 0;
async function insertOrderWithProduct(opts: {
  productId: string;
  status: "processing" | "shipped" | "delivered" | "cancelled" | "accepted";
}): Promise<string> {
  const db = getDb();
  orderSeq += 1;
  const [order] = await db
    .insert(schema.orders)
    .values({
      orderNumber: `2026-06-${String(orderSeq).padStart(5, "0")}`,
      idempotencyKey: `idem-${orderSeq}-${Date.now()}`,
      paymentMethod: "cash_on_delivery",
      status: opts.status,
      customerEmail: "buyer@example.com",
      customerPhone: "+359888000000",
      customerName: "Купувач",
      subtotalCents: "1999",
      totalCents: "1999",
    })
    .returning({ id: schema.orders.id });
  if (!order) throw new Error("order seed failed");
  await db.insert(schema.orderItems).values({
    orderId: order.id,
    productId: opts.productId,
    productCode: "SNAP-1",
    productName: "Snapshot name",
    unitPriceCents: "1999",
    quantity: 1,
  });
  return order.id;
}

async function getJson(path: string, cookie: string) {
  const res = await app.request(path, {
    headers: { cookie, Accept: "application/json" },
  });
  const body = (await res.json()) as any;
  return { res, body };
}

async function send(
  path: string,
  cookie: string,
  method: string,
  body: unknown,
) {
  const res = await app.request(path, {
    method,
    headers: {
      cookie,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  return { res, body: json };
}

// ─── Auth gate ───────────────────────────────────────────────────────────────

describe("admin categories — auth gate", () => {
  it("returns 404 (not 401) with no session", async () => {
    const res = await app.request("/admin/categories");
    expect(res.status).toBe(404);
  });

  it("returns 404 for a signed-in customer", async () => {
    const cookie = await seedCustomerSession();
    const res = await app.request("/admin/categories", { headers: { cookie } });
    expect(res.status).toBe(404);
  });

  it("blocks a customer from creating a category", async () => {
    const cookie = await seedCustomerSession();
    const { res } = await send("/admin/categories", cookie, "POST", {
      name: "Хак",
      slug: "hack",
    });
    expect(res.status).toBe(404);
  });
});

// ─── GET tree ──────────────────────────────────────────────────────────────

describe("admin categories — list tree", () => {
  it("returns an empty tree when there are no categories", async () => {
    const cookie = await seedAdminSession();
    const { res, body } = await getJson("/admin/categories", cookie);
    expect(res.status).toBe(200);
    expect(body.items).toEqual([]);
  });

  it("nests children and computes product + descendant counts", async () => {
    const cookie = await seedAdminSession();
    const root = await insertCategory({ name: "Електроника", slug: "elektronika" });
    const child = await insertCategory({
      name: "Телефони",
      slug: "telefoni",
      parentId: root.id,
    });
    await insertProduct({
      slug: "phone-1",
      code: "P1",
      name: "Телефон 1",
      categoryId: child.id,
    });

    const { body } = await getJson("/admin/categories", cookie);
    expect(body.items).toHaveLength(1);
    const rootNode = body.items[0];
    expect(rootNode.id).toBe(root.id);
    expect(rootNode.descendantCategoryCount).toBe(1);
    expect(rootNode.productCount).toBe(0);
    expect(typeof rootNode.updatedAt).toBe("string");
    expect(rootNode.children).toHaveLength(1);
    expect(rootNode.children[0].productCount).toBe(1);
  });

  it("derives imageUrl from the stored S3 key (null when unset)", async () => {
    const cookie = await seedAdminSession();
    await insertCategory({ name: "С", slug: "s", imageS3Key: "categories/a.jpg" });
    await insertCategory({ name: "Без", slug: "bez" });
    const { body } = await getJson("/admin/categories", cookie);
    const withImg = body.items.find((n: any) => n.slug === "s");
    const without = body.items.find((n: any) => n.slug === "bez");
    expect(withImg.imageUrl).toBeTruthy();
    expect(without.imageUrl).toBeNull();
  });

  it("excludes soft-deleted categories", async () => {
    const cookie = await seedAdminSession();
    const db = getDb();
    await insertCategory({ name: "Жива", slug: "zhiva" });
    await db
      .insert(schema.categories)
      .values({ name: "Изтрита", slug: "iztrita", deletedAt: new Date() });
    const { body } = await getJson("/admin/categories", cookie);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].slug).toBe("zhiva");
  });
});

// ─── Create ──────────────────────────────────────────────────────────────────

describe("admin categories — create", () => {
  it("creates a root category with an explicit slug (201)", async () => {
    const cookie = await seedAdminSession();
    const { res, body } = await send("/admin/categories", cookie, "POST", {
      name: "Инструменти",
      slug: "instrumenti",
    });
    expect(res.status).toBe(201);
    expect(body.slug).toBe("instrumenti");
    expect(body.parentId).toBeNull();
  });

  it("derives a Latin slug from a Bulgarian name when slug is omitted", async () => {
    const cookie = await seedAdminSession();
    const { body } = await send("/admin/categories", cookie, "POST", {
      name: "Електроника",
    });
    expect(body.slug).toBe("elektronika");
  });

  it("appends to the end of the layer (increasing displayOrder)", async () => {
    const cookie = await seedAdminSession();
    const a = await send("/admin/categories", cookie, "POST", {
      name: "Първа",
      slug: "parva",
    });
    const b = await send("/admin/categories", cookie, "POST", {
      name: "Втора",
      slug: "vtora",
    });
    expect(b.body.displayOrder).toBeGreaterThan(a.body.displayOrder);
  });

  it("rejects a duplicate slug under the same parent (409)", async () => {
    const cookie = await seedAdminSession();
    await send("/admin/categories", cookie, "POST", { name: "X", slug: "dup" });
    const { res, body } = await send("/admin/categories", cookie, "POST", {
      name: "Y",
      slug: "dup",
    });
    expect(res.status).toBe(409);
    expect(body.type).toBe("/problems/category-slug-conflict");
  });

  it("allows the same slug under different parents", async () => {
    const cookie = await seedAdminSession();
    const p1 = await insertCategory({ name: "P1", slug: "p1" });
    const p2 = await insertCategory({ name: "P2", slug: "p2" });
    const a = await send("/admin/categories", cookie, "POST", {
      name: "Калъфи",
      slug: "kalafi",
      parentId: p1.id,
    });
    const b = await send("/admin/categories", cookie, "POST", {
      name: "Калъфи",
      slug: "kalafi",
      parentId: p2.id,
    });
    expect(a.res.status).toBe(201);
    expect(b.res.status).toBe(201);
  });

  it("enforces root-slug uniqueness application-side (409)", async () => {
    const cookie = await seedAdminSession();
    await insertCategory({ name: "Root", slug: "root-dup" });
    const { res } = await send("/admin/categories", cookie, "POST", {
      name: "Root2",
      slug: "root-dup",
    });
    expect(res.status).toBe(409);
  });

  it("rejects an unknown parent (400)", async () => {
    const cookie = await seedAdminSession();
    const { res, body } = await send("/admin/categories", cookie, "POST", {
      name: "Сирак",
      slug: "sirak",
      parentId: "00000000-0000-0000-0000-000000000000",
    });
    expect(res.status).toBe(400);
    expect(body.errors?.[0]?.path).toBe("parentId");
  });

  it("rejects an invalid slug format (400)", async () => {
    const cookie = await seedAdminSession();
    const { res } = await send("/admin/categories", cookie, "POST", {
      name: "Bad",
      slug: "Bad Slug!",
    });
    expect(res.status).toBe(400);
  });

  it("writes a category.create audit row", async () => {
    const cookie = await seedAdminSession();
    const { body } = await send("/admin/categories", cookie, "POST", {
      name: "Одит",
      slug: "odit",
    });
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.adminAuditLog)
      .where(eq(schema.adminAuditLog.entityId, body.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("category.create");
  });
});

// ─── Update / move ─────────────────────────────────────────────────────────

async function currentUpdatedAt(cookie: string, id: string): Promise<string> {
  const { body } = await getJson("/admin/categories", cookie);
  const find = (nodes: any[]): any =>
    nodes.reduce<any>(
      (acc, n) => acc ?? (n.id === id ? n : find(n.children)),
      null,
    );
  return find(body.items).updatedAt;
}

describe("admin categories — update & move", () => {
  it("renames a category", async () => {
    const cookie = await seedAdminSession();
    const cat = await insertCategory({ name: "Старо", slug: "staro" });
    const expectedUpdatedAt = await currentUpdatedAt(cookie, cat.id);
    const { res, body } = await send(`/admin/categories/${cat.id}`, cookie, "PATCH", {
      expectedUpdatedAt,
      name: "Ново",
    });
    expect(res.status).toBe(200);
    expect(body.name).toBe("Ново");
  });

  it("rejects a stale expectedUpdatedAt with a version conflict (409)", async () => {
    const cookie = await seedAdminSession();
    const cat = await insertCategory({ name: "А", slug: "a" });
    const stale = new Date(Date.now() - 60_000).toISOString();
    const { res, body } = await send(`/admin/categories/${cat.id}`, cookie, "PATCH", {
      expectedUpdatedAt: stale,
      name: "Б",
    });
    expect(res.status).toBe(409);
    expect(body.type).toBe("/problems/category-version-conflict");
  });

  it("moves a category under a new parent", async () => {
    const cookie = await seedAdminSession();
    const a = await insertCategory({ name: "A", slug: "a" });
    const b = await insertCategory({ name: "B", slug: "b" });
    const expectedUpdatedAt = await currentUpdatedAt(cookie, b.id);
    const { res, body } = await send(`/admin/categories/${b.id}`, cookie, "PATCH", {
      expectedUpdatedAt,
      parentId: a.id,
    });
    expect(res.status).toBe(200);
    expect(body.parentId).toBe(a.id);
  });

  it("rejects moving a category under itself (422 cycle)", async () => {
    const cookie = await seedAdminSession();
    const a = await insertCategory({ name: "A", slug: "a" });
    const expectedUpdatedAt = await currentUpdatedAt(cookie, a.id);
    const { res, body } = await send(`/admin/categories/${a.id}`, cookie, "PATCH", {
      expectedUpdatedAt,
      parentId: a.id,
    });
    expect(res.status).toBe(422);
    expect(body.type).toBe("/problems/category-move-cycle");
  });

  it("rejects moving a category under one of its descendants (422)", async () => {
    const cookie = await seedAdminSession();
    const a = await insertCategory({ name: "A", slug: "a" });
    const b = await insertCategory({ name: "B", slug: "b", parentId: a.id });
    const expectedUpdatedAt = await currentUpdatedAt(cookie, a.id);
    const { res } = await send(`/admin/categories/${a.id}`, cookie, "PATCH", {
      expectedUpdatedAt,
      parentId: b.id,
    });
    expect(res.status).toBe(422);
  });

  it("rejects a slug collision created by a move (409)", async () => {
    const cookie = await seedAdminSession();
    const a = await insertCategory({ name: "A", slug: "a" });
    await insertCategory({ name: "Dup", slug: "shared", parentId: a.id });
    const mover = await insertCategory({ name: "Mover", slug: "shared" }); // root
    const expectedUpdatedAt = await currentUpdatedAt(cookie, mover.id);
    const { res, body } = await send(`/admin/categories/${mover.id}`, cookie, "PATCH", {
      expectedUpdatedAt,
      parentId: a.id,
    });
    expect(res.status).toBe(409);
    expect(body.type).toBe("/problems/category-slug-conflict");
  });

  it("clears the image when imageS3Key is null", async () => {
    const cookie = await seedAdminSession();
    const cat = await insertCategory({
      name: "Имг",
      slug: "img",
      imageS3Key: "categories/x.jpg",
    });
    const expectedUpdatedAt = await currentUpdatedAt(cookie, cat.id);
    const { body } = await send(`/admin/categories/${cat.id}`, cookie, "PATCH", {
      expectedUpdatedAt,
      imageS3Key: null,
    });
    expect(body.imageUrl).toBeNull();
    expect(body.imageS3Key).toBeNull();
  });

  it("returns 404 for an unknown category", async () => {
    const cookie = await seedAdminSession();
    const { res } = await send(
      "/admin/categories/00000000-0000-0000-0000-000000000000",
      cookie,
      "PATCH",
      { expectedUpdatedAt: new Date().toISOString(), name: "x" },
    );
    expect(res.status).toBe(404);
  });

  it("rejects an empty update body (400)", async () => {
    const cookie = await seedAdminSession();
    const cat = await insertCategory({ name: "E", slug: "e" });
    const expectedUpdatedAt = await currentUpdatedAt(cookie, cat.id);
    const { res } = await send(`/admin/categories/${cat.id}`, cookie, "PATCH", {
      expectedUpdatedAt,
    });
    expect(res.status).toBe(400);
  });
});

// ─── Reorder ─────────────────────────────────────────────────────────────────

describe("admin categories — reorder", () => {
  it("rewrites displayOrder for a layer of siblings", async () => {
    const cookie = await seedAdminSession();
    const a = await insertCategory({ name: "A", slug: "a", displayOrder: 0 });
    const b = await insertCategory({ name: "B", slug: "b", displayOrder: 1 });
    const c = await insertCategory({ name: "C", slug: "c", displayOrder: 2 });
    const { res, body } = await send("/admin/categories/reorder", cookie, "POST", {
      parentId: null,
      orderedIds: [c.id, a.id, b.id],
    });
    expect(res.status).toBe(200);
    const order = body.items.map((n: any) => n.id);
    expect(order).toEqual([c.id, a.id, b.id]);
  });

  it("rejects a set that is not exactly the layer's siblings (409)", async () => {
    const cookie = await seedAdminSession();
    const a = await insertCategory({ name: "A", slug: "a" });
    await insertCategory({ name: "B", slug: "b" });
    const { res, body } = await send("/admin/categories/reorder", cookie, "POST", {
      parentId: null,
      orderedIds: [a.id], // missing B
    });
    expect(res.status).toBe(409);
    expect(body.type).toBe("/problems/category-reorder-mismatch");
  });

  it("rejects duplicate ids (409)", async () => {
    const cookie = await seedAdminSession();
    const a = await insertCategory({ name: "A", slug: "a" });
    const { res } = await send("/admin/categories/reorder", cookie, "POST", {
      parentId: null,
      orderedIds: [a.id, a.id],
    });
    expect(res.status).toBe(409);
  });
});

// ─── Deletion impact ─────────────────────────────────────────────────────────

describe("admin categories — deletion impact", () => {
  it("counts subcategories and products", async () => {
    const cookie = await seedAdminSession();
    const root = await insertCategory({ name: "R", slug: "r" });
    const child = await insertCategory({ name: "C", slug: "c", parentId: root.id });
    await insertProduct({ slug: "p1", code: "P1", name: "P1", categoryId: root.id });
    await insertProduct({ slug: "p2", code: "P2", name: "P2", categoryId: child.id });
    const { res, body } = await getJson(
      `/admin/categories/${root.id}/deletion-impact`,
      cookie,
    );
    expect(res.status).toBe(200);
    expect(body.subcategoryCount).toBe(1);
    expect(body.productCount).toBe(2);
  });

  it("counts products that sit in active orders", async () => {
    const cookie = await seedAdminSession();
    const cat = await insertCategory({ name: "R", slug: "r" });
    const pid = await insertProduct({ slug: "p", code: "P", name: "P", categoryId: cat.id });
    await insertOrderWithProduct({ productId: pid, status: "processing" });
    const { body } = await getJson(`/admin/categories/${cat.id}/deletion-impact`, cookie);
    expect(body.productsInActiveOrders).toBe(1);
    expect(body.activeOrderCount).toBe(1);
  });

  it("does not count products only in terminal orders", async () => {
    const cookie = await seedAdminSession();
    const cat = await insertCategory({ name: "R", slug: "r" });
    const pid = await insertProduct({ slug: "p", code: "P", name: "P", categoryId: cat.id });
    await insertOrderWithProduct({ productId: pid, status: "cancelled" });
    const { body } = await getJson(`/admin/categories/${cat.id}/deletion-impact`, cookie);
    expect(body.productsInActiveOrders).toBe(0);
    expect(body.activeOrderCount).toBe(0);
  });

  it("returns 404 for an unknown category", async () => {
    const cookie = await seedAdminSession();
    const { res } = await getJson(
      "/admin/categories/00000000-0000-0000-0000-000000000000/deletion-impact",
      cookie,
    );
    expect(res.status).toBe(404);
  });
});

// ─── Delete (cascade + redirects) ────────────────────────────────────────────

describe("admin categories — cascade delete", () => {
  it("soft-deletes the subtree and its products", async () => {
    const cookie = await seedAdminSession();
    const root = await insertCategory({ name: "Електроника", slug: "elektronika" });
    const child = await insertCategory({
      name: "Телефони",
      slug: "telefoni",
      parentId: root.id,
    });
    const pid = await insertProduct({
      slug: "old-phone",
      code: "OP",
      name: "Old",
      categoryId: child.id,
    });
    const expectedUpdatedAt = await currentUpdatedAt(cookie, root.id);

    const { res, body } = await send(`/admin/categories/${root.id}`, cookie, "DELETE", {
      expectedUpdatedAt,
      confirmConsequences: true,
    });
    expect(res.status).toBe(200);
    expect(body.deletedCategories).toBe(2);
    expect(body.deletedProducts).toBe(1);

    const db = getDb();
    const liveCats = await db
      .select()
      .from(schema.categories)
      .where(isNull(schema.categories.deletedAt));
    expect(liveCats).toHaveLength(0);
    const [prod] = await db
      .select()
      .from(schema.products)
      .where(eq(schema.products.id, pid));
    expect(prod!.deletedAt).not.toBeNull();
  });

  it("writes 301 redirects to home for a deleted root subtree", async () => {
    const cookie = await seedAdminSession();
    const root = await insertCategory({ name: "Електроника", slug: "elektronika" });
    const child = await insertCategory({
      name: "Телефони",
      slug: "telefoni",
      parentId: root.id,
    });
    await insertProduct({ slug: "old-phone", code: "OP", name: "Old", categoryId: child.id });
    const expectedUpdatedAt = await currentUpdatedAt(cookie, root.id);

    await send(`/admin/categories/${root.id}`, cookie, "DELETE", {
      expectedUpdatedAt,
      confirmConsequences: true,
    });

    const db = getDb();
    const redirects = await db.select().from(schema.redirects);
    const paths = redirects.map((r) => r.sourcePath).sort();
    expect(paths).toContain("/products/elektronika");
    expect(paths).toContain("/products/elektronika/telefoni");
    expect(paths).toContain("/products/elektronika/telefoni/old-phone");
    for (const r of redirects) {
      expect(r.targetKind).toBe("home");
      expect(r.statusCode).toBe(301);
    }
  });

  it("redirects a deleted subcategory to its surviving parent", async () => {
    const cookie = await seedAdminSession();
    const root = await insertCategory({ name: "Електроника", slug: "elektronika" });
    const child = await insertCategory({
      name: "Телефони",
      slug: "telefoni",
      parentId: root.id,
    });
    const expectedUpdatedAt = await currentUpdatedAt(cookie, child.id);

    await send(`/admin/categories/${child.id}`, cookie, "DELETE", {
      expectedUpdatedAt,
      confirmConsequences: true,
    });

    const db = getDb();
    const [redirect] = await db
      .select()
      .from(schema.redirects)
      .where(eq(schema.redirects.sourcePath, "/products/elektronika/telefoni"));
    expect(redirect!.targetKind).toBe("category");
    expect(redirect!.targetCategoryId).toBe(root.id);
  });

  it("requires confirmConsequences === true (400 otherwise)", async () => {
    const cookie = await seedAdminSession();
    const cat = await insertCategory({ name: "C", slug: "c" });
    const expectedUpdatedAt = await currentUpdatedAt(cookie, cat.id);
    const { res } = await send(`/admin/categories/${cat.id}`, cookie, "DELETE", {
      expectedUpdatedAt,
      confirmConsequences: false,
    });
    expect(res.status).toBe(400);
  });

  it("rejects a stale delete with a version conflict (409)", async () => {
    const cookie = await seedAdminSession();
    const cat = await insertCategory({ name: "C", slug: "c" });
    const { res, body } = await send(`/admin/categories/${cat.id}`, cookie, "DELETE", {
      expectedUpdatedAt: new Date(Date.now() - 60_000).toISOString(),
      confirmConsequences: true,
    });
    expect(res.status).toBe(409);
    expect(body.type).toBe("/problems/category-version-conflict");
  });

  it("leaves order history (line-item snapshots) intact", async () => {
    const cookie = await seedAdminSession();
    const cat = await insertCategory({ name: "C", slug: "c" });
    const pid = await insertProduct({ slug: "p", code: "P", name: "P", categoryId: cat.id });
    const orderId = await insertOrderWithProduct({ productId: pid, status: "processing" });
    const expectedUpdatedAt = await currentUpdatedAt(cookie, cat.id);

    await send(`/admin/categories/${cat.id}`, cookie, "DELETE", {
      expectedUpdatedAt,
      confirmConsequences: true,
    });

    const db = getDb();
    const items = await db
      .select()
      .from(schema.orderItems)
      .where(eq(schema.orderItems.orderId, orderId));
    expect(items).toHaveLength(1);
    expect(items[0]!.productName).toBe("Snapshot name");
  });

  it("writes a category.delete audit row with counts", async () => {
    const cookie = await seedAdminSession();
    const root = await insertCategory({ name: "R", slug: "r" });
    await insertCategory({ name: "C", slug: "c", parentId: root.id });
    const expectedUpdatedAt = await currentUpdatedAt(cookie, root.id);

    await send(`/admin/categories/${root.id}`, cookie, "DELETE", {
      expectedUpdatedAt,
      confirmConsequences: true,
    });

    const db = getDb();
    const [audit] = await db
      .select()
      .from(schema.adminAuditLog)
      .where(
        and(
          eq(schema.adminAuditLog.entityId, root.id),
          eq(schema.adminAuditLog.action, "category.delete"),
        ),
      );
    expect(audit).toBeTruthy();
    expect((audit!.changes as any).deletedCategories).toBe(2);
  });
});
