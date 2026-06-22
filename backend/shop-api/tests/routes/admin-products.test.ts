import { hashPassword } from "@shop/auth";
import { schema } from "@shop/db";
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { sessionCookieName } from "../../src/lib/cookies.js";
import { getDb } from "../../src/lib/db.js";
import { createSession } from "../../src/lib/sessions.js";

/**
 * Integration tests for the admin product-management slice
 * (routes/admin/products.ts): the requireAdmin gate, the offset-paginated list
 * with filters + search, create (slug derivation + SKU/slug uniqueness across
 * archived rows + image set + append ordering), full detail (incl. archived +
 * active-order count), PATCH (edit / move / re-image with optimistic locking via
 * updatedAt + FOR UPDATE), the within-category reorder, the soft-delete that
 * writes a 301 redirect, and restore (which clears it + re-homes orphans).
 * Exercised against the live route + real Postgres so middleware order,
 * transactions, and the Bulgarian→Latin slug fallback are all under test.
 */

let app: ReturnType<typeof buildApp>;
let adminCookie: string;
let customerCookie: string;
let passwordHash: string;

const PASSWORD = "correct horse battery staple";
const RUN = Date.now().toString(36);
let seq = 0;
const uniq = (base: string) => `${base}-${RUN}-${++seq}`;

function cookieHeader(token: string): string {
  return `${sessionCookieName()}=${token}`;
}

async function seedSession(role: "admin" | "customer", email: string): Promise<string> {
  const db = getDb();
  const [user] = await db
    .insert(schema.users)
    .values({
      email: email.toLowerCase(),
      passwordHash,
      role,
      accountType: role === "customer" ? "personal" : null,
      emailVerifiedAt: new Date(),
      mfaEnabled: role === "admin",
    })
    .returning();
  if (!user) throw new Error("user seed failed");
  const { token } = await createSession({
    userId: user.id,
    rememberMe: false,
    role,
    ipAddress: null,
    userAgent: null,
  });
  return cookieHeader(token);
}

async function insertCategory(slug: string, name = slug): Promise<string> {
  const db = getDb();
  const [row] = await db
    .insert(schema.categories)
    .values({ name, slug, parentId: null, displayOrder: 0 })
    .returning({ id: schema.categories.id });
  if (!row) throw new Error("category seed failed");
  return row.id;
}

async function getJson(path: string, cookie = adminCookie) {
  const res = await app.request(path, { headers: { cookie, Accept: "application/json" } });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* no body */
  }
  return { res, body };
}

async function send(path: string, method: string, body: unknown, cookie = adminCookie) {
  const res = await app.request(path, {
    method,
    headers: { cookie, Accept: "application/json", "Content-Type": "application/json" },
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

/** Create a product via the API and return its detail body. */
async function createProduct(overrides: Record<string, unknown> = {}) {
  const base = {
    name: "Тест продукт",
    code: uniq("SKU").toUpperCase(),
    slug: uniq("p"),
    priceCents: 1999,
    ...overrides,
  };
  const { res, body } = await send("/admin/products", "POST", base);
  return { res, body, input: base };
}

beforeAll(async () => {
  app = buildApp();
  // Hash once and reuse — argon2 is deliberately slow, and the per-test
  // beforeEach below re-seeds two users before every test.
  passwordHash = await hashPassword(PASSWORD);
});

// The shared harness (tests/setup/per-test.ts) TRUNCATEs every table before
// each test, so the admin + customer sessions must be re-seeded per test —
// seeding once in beforeAll would be wiped before the first test runs. Same
// reason the other admin suites seed inside each test.
beforeEach(async () => {
  adminCookie = await seedSession("admin", `admin-${RUN}@shop.bg`);
  customerCookie = await seedSession("customer", `cust-${RUN}@example.com`);
});

// ─── Auth gate ────────────────────────────────────────────────────────────────

describe("admin products — auth gate", () => {
  it("returns 404 (not 401) with no session", async () => {
    const res = await app.request("/admin/products");
    expect(res.status).toBe(404);
  });

  it("returns 404 for a signed-in customer", async () => {
    const res = await app.request("/admin/products", { headers: { cookie: customerCookie } });
    expect(res.status).toBe(404);
  });

  it("blocks a customer from creating a product", async () => {
    const { res } = await send(
      "/admin/products",
      "POST",
      { name: "X", code: uniq("SKU"), priceCents: 100 },
      customerCookie,
    );
    expect(res.status).toBe(404);
  });
});

// ─── Create ─────────────────────────────────────────────────────────────────

describe("admin products — create", () => {
  it("creates a minimal product (slug derived, NEW by default)", async () => {
    const code = uniq("SKU").toUpperCase();
    const { res, body } = await send("/admin/products", "POST", {
      name: "Слушалки Сони",
      code,
      priceCents: 12999,
    });
    expect(res.status).toBe(201);
    expect(body.slug).toBe("slushalki-soni");
    expect(body.code).toBe(code);
    expect(body.priceCents).toBe(12999);
    expect(body.currency).toBe("EUR");
    expect(body.stockStatus).toBe("in_stock");
    expect(body.isNew).toBe(true);
    expect(body.archived).toBe(false);
    expect(body.displayOrder).toBe(0);
    expect(body.images).toEqual([]);
  });

  it("creates with category + images (primary image + categoryName resolved)", async () => {
    const catId = await insertCategory(uniq("cat"));
    const { res, body } = await createProduct({
      categoryId: catId,
      images: [
        { s3Key: "products/x/main.jpg", altText: "main" },
        { s3Key: "products/x/side.jpg" },
      ],
    });
    expect(res.status).toBe(201);
    expect(body.categoryId).toBe(catId);
    expect(body.categoryName).toBeTruthy();
    expect(body.images).toHaveLength(2);
    expect(body.images[0].displayOrder).toBe(0);
    expect(body.primaryImageUrl).toMatch(/^https?:\/\//);
  });

  it("rejects a duplicate slug with 409", async () => {
    const slug = uniq("dupe");
    await createProduct({ slug });
    const { res, body } = await createProduct({ slug });
    expect(res.status).toBe(409);
    expect(body.type).toBe("/problems/product-slug-conflict");
  });

  it("rejects a duplicate SKU with 409", async () => {
    const code = uniq("DUPSKU").toUpperCase();
    await createProduct({ code });
    const { res, body } = await createProduct({ code });
    expect(res.status).toBe(409);
    expect(body.type).toBe("/problems/product-code-conflict");
  });

  it("rejects an unknown category with 400", async () => {
    const { res } = await createProduct({
      categoryId: "00000000-0000-0000-0000-000000000000",
    });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid explicit slug with 400", async () => {
    const { res } = await send("/admin/products", "POST", {
      name: "X",
      code: uniq("SKU"),
      slug: "Not A Slug",
      priceCents: 100,
    });
    expect(res.status).toBe(400);
  });

  it("honours newUntil:null (no NEW badge)", async () => {
    const { body } = await createProduct({ newUntil: null });
    expect(body.isNew).toBe(false);
    expect(body.newUntil).toBeNull();
  });

  it("writes a product.create audit-log row", async () => {
    const { body } = await createProduct();
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.adminAuditLog)
      .where(
        and(
          eq(schema.adminAuditLog.action, "product.create"),
          eq(schema.adminAuditLog.entityId, body.id),
        ),
      );
    expect(rows).toHaveLength(1);
  });
});

// ─── Detail ─────────────────────────────────────────────────────────────────

describe("admin products — detail", () => {
  it("returns 404 for an unknown id", async () => {
    const { res, body } = await getJson("/admin/products/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
    expect(body.type).toBe("/problems/product-not-found");
  });

  it("returns full detail with the optimistic-lock token", async () => {
    const { body: created } = await createProduct();
    const { res, body } = await getJson(`/admin/products/${created.id}`);
    expect(res.status).toBe(200);
    expect(body.id).toBe(created.id);
    expect(typeof body.updatedAt).toBe("string");
    expect(body.activeOrderCount).toBe(0);
  });

  it("counts active orders that reference the product", async () => {
    const { body: created } = await createProduct();
    const db = getDb();
    seq += 1;
    const [order] = await db
      .insert(schema.orders)
      .values({
        orderNumber: `PT-${RUN}-${seq}`,
        idempotencyKey: `idem-${RUN}-${seq}`,
        paymentMethod: "cash_on_delivery",
        status: "processing",
        customerEmail: "buyer@example.com",
        customerPhone: "+359888000000",
        customerName: "Купувач",
        subtotalCents: "1999",
        totalCents: "1999",
      })
      .returning({ id: schema.orders.id });
    await db.insert(schema.orderItems).values({
      orderId: order!.id,
      productId: created.id,
      productCode: "SNAP",
      productName: "snap",
      unitPriceCents: "1999",
      quantity: 1,
    });
    const { body } = await getJson(`/admin/products/${created.id}`);
    expect(body.activeOrderCount).toBe(1);
  });
});

// ─── List ───────────────────────────────────────────────────────────────────

describe("admin products — list", () => {
  it("paginates with a total and totalPages", async () => {
    const catId = await insertCategory(uniq("listcat"));
    for (let i = 0; i < 3; i++) await createProduct({ categoryId: catId });
    const { res, body } = await getJson(
      `/admin/products?categoryId=${catId}&pageSize=2&page=1`,
    );
    expect(res.status).toBe(200);
    expect(body.total).toBe(3);
    expect(body.pageSize).toBe(2);
    expect(body.items).toHaveLength(2);
    expect(body.totalPages).toBe(2);
  });

  it("filters by stockStatus", async () => {
    const catId = await insertCategory(uniq("stockcat"));
    await createProduct({ categoryId: catId, stockStatus: "out_of_stock" });
    await createProduct({ categoryId: catId, stockStatus: "in_stock" });
    const { body } = await getJson(
      `/admin/products?categoryId=${catId}&stockStatus=out_of_stock`,
    );
    expect(body.total).toBe(1);
    expect(body.items[0].stockStatus).toBe("out_of_stock");
  });

  it("searches by SKU code", async () => {
    const code = uniq("FINDME").toUpperCase();
    await createProduct({ code });
    const { body } = await getJson(`/admin/products?q=${code}`);
    expect(body.total).toBe(1);
    expect(body.items[0].code).toBe(code);
  });

  it("excludes archived products by default and shows them on status=archived", async () => {
    const catId = await insertCategory(uniq("archcat"));
    const { body: p } = await createProduct({ categoryId: catId });
    await send(`/admin/products/${p.id}`, "DELETE", {
      expectedUpdatedAt: p.updatedAt,
      confirmConsequences: true,
    });
    const active = await getJson(`/admin/products?categoryId=${catId}&status=active`);
    expect(active.body.total).toBe(0);
    const archived = await getJson(`/admin/products?categoryId=${catId}&status=archived`);
    expect(archived.body.total).toBe(1);
    expect(archived.body.items[0].archived).toBe(true);
  });
});

// ─── Update ─────────────────────────────────────────────────────────────────

describe("admin products — update", () => {
  it("edits name + price with the correct version token", async () => {
    const { body: p } = await createProduct();
    const { res, body } = await send(`/admin/products/${p.id}`, "PATCH", {
      expectedUpdatedAt: p.updatedAt,
      name: "Ново име",
      priceCents: 4200,
    });
    expect(res.status).toBe(200);
    expect(body.name).toBe("Ново име");
    expect(body.priceCents).toBe(4200);
  });

  it("rejects a stale version token with 409", async () => {
    const { body: p } = await createProduct();
    const { res, body } = await send(`/admin/products/${p.id}`, "PATCH", {
      expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
      name: "Stale",
    });
    expect(res.status).toBe(409);
    expect(body.type).toBe("/problems/product-version-conflict");
  });

  it("rejects an empty update (only the version token) with 400", async () => {
    const { body: p } = await createProduct();
    const { res } = await send(`/admin/products/${p.id}`, "PATCH", {
      expectedUpdatedAt: p.updatedAt,
    });
    expect(res.status).toBe(400);
  });

  it("rejects renaming the slug onto an existing one with 409", async () => {
    const taken = uniq("taken");
    await createProduct({ slug: taken });
    const { body: p } = await createProduct();
    const { res, body } = await send(`/admin/products/${p.id}`, "PATCH", {
      expectedUpdatedAt: p.updatedAt,
      slug: taken,
    });
    expect(res.status).toBe(409);
    expect(body.type).toBe("/problems/product-slug-conflict");
  });

  it("rejects a SKU collision with 409", async () => {
    const taken = uniq("TAKENSKU").toUpperCase();
    await createProduct({ code: taken });
    const { body: p } = await createProduct();
    const { res, body } = await send(`/admin/products/${p.id}`, "PATCH", {
      expectedUpdatedAt: p.updatedAt,
      code: taken,
    });
    expect(res.status).toBe(409);
    expect(body.type).toBe("/problems/product-code-conflict");
  });

  it("rejects a move to an unknown category with 400", async () => {
    const { body: p } = await createProduct();
    const { res } = await send(`/admin/products/${p.id}`, "PATCH", {
      expectedUpdatedAt: p.updatedAt,
      categoryId: "00000000-0000-0000-0000-000000000000",
    });
    expect(res.status).toBe(400);
  });

  it("replaces the image set, then clears it with []", async () => {
    const { body: p } = await createProduct({
      images: [{ s3Key: "products/old.jpg" }],
    });
    const replaced = await send(`/admin/products/${p.id}`, "PATCH", {
      expectedUpdatedAt: p.updatedAt,
      images: [{ s3Key: "products/new1.jpg" }, { s3Key: "products/new2.jpg" }],
    });
    expect(replaced.body.images).toHaveLength(2);
    expect(replaced.body.images[0].s3Key).toBe("products/new1.jpg");
    const cleared = await send(`/admin/products/${p.id}`, "PATCH", {
      expectedUpdatedAt: replaced.body.updatedAt,
      images: [],
    });
    expect(cleared.body.images).toHaveLength(0);
    expect(cleared.body.primaryImageUrl).toBeNull();
  });

  it("moves a product to uncategorised with categoryId:null", async () => {
    const catId = await insertCategory(uniq("movecat"));
    const { body: p } = await createProduct({ categoryId: catId });
    const { body } = await send(`/admin/products/${p.id}`, "PATCH", {
      expectedUpdatedAt: p.updatedAt,
      categoryId: null,
    });
    expect(body.categoryId).toBeNull();
    expect(body.categoryName).toBeNull();
  });
});

// ─── Reorder ────────────────────────────────────────────────────────────────

describe("admin products — reorder", () => {
  it("rewrites the display order within a category", async () => {
    const catId = await insertCategory(uniq("reordercat"));
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { body } = await createProduct({ categoryId: catId });
      ids.push(body.id);
    }
    const reversed = [...ids].reverse();
    const { res, body } = await send("/admin/products/reorder", "POST", {
      categoryId: catId,
      orderedIds: reversed,
    });
    expect(res.status).toBe(200);
    expect(body.reordered).toBe(3);
    // The product placed last in `reversed` should now have displayOrder 2.
    const detail = await getJson(`/admin/products/${reversed[2]}`);
    expect(detail.body.displayOrder).toBe(2);
  });

  it("rejects an id set that is not exactly the category's products", async () => {
    const catId = await insertCategory(uniq("reordermiss"));
    const { body: a } = await createProduct({ categoryId: catId });
    const { res, body } = await send("/admin/products/reorder", "POST", {
      categoryId: catId,
      orderedIds: [a.id, "00000000-0000-0000-0000-000000000000"],
    });
    expect(res.status).toBe(409);
    expect(body.type).toBe("/problems/product-reorder-mismatch");
  });
});

// ─── Delete + restore ─────────────────────────────────────────────────────────

describe("admin products — delete & restore", () => {
  it("soft-deletes and writes a 301 redirect to the category", async () => {
    const catSlug = uniq("delcat");
    const catId = await insertCategory(catSlug);
    const prodSlug = uniq("delprod");
    const { body: p } = await createProduct({ categoryId: catId, slug: prodSlug });

    const { res, body } = await send(`/admin/products/${p.id}`, "DELETE", {
      expectedUpdatedAt: p.updatedAt,
      confirmConsequences: true,
    });
    expect(res.status).toBe(200);
    expect(body.archived).toBe(true);
    expect(body.redirectsWritten).toBe(1);

    const db = getDb();
    const [prod] = await db
      .select({ deletedAt: schema.products.deletedAt })
      .from(schema.products)
      .where(eq(schema.products.id, p.id));
    expect(prod!.deletedAt).not.toBeNull();

    const expectedPath = `/products/${catSlug}/${prodSlug}`;
    const [redir] = await db
      .select()
      .from(schema.redirects)
      .where(eq(schema.redirects.sourcePath, expectedPath));
    expect(redir).toBeTruthy();
    expect(redir!.statusCode).toBe(301);
    expect(redir!.targetKind).toBe("category");
  });

  it("rejects delete without confirmConsequences:true (400)", async () => {
    const { body: p } = await createProduct();
    const { res } = await send(`/admin/products/${p.id}`, "DELETE", {
      expectedUpdatedAt: p.updatedAt,
      confirmConsequences: false,
    });
    expect(res.status).toBe(400);
  });

  it("rejects delete with a stale version (409)", async () => {
    const { body: p } = await createProduct();
    const { res, body } = await send(`/admin/products/${p.id}`, "DELETE", {
      expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
      confirmConsequences: true,
    });
    expect(res.status).toBe(409);
    expect(body.type).toBe("/problems/product-version-conflict");
  });

  it("returns 404 deleting an unknown product", async () => {
    const { res } = await send(
      "/admin/products/00000000-0000-0000-0000-000000000000",
      "DELETE",
      { expectedUpdatedAt: new Date().toISOString(), confirmConsequences: true },
    );
    expect(res.status).toBe(404);
  });

  it("restores an archived product and removes its redirect", async () => {
    const catSlug = uniq("rescat");
    const catId = await insertCategory(catSlug);
    const prodSlug = uniq("resprod");
    const { body: p } = await createProduct({ categoryId: catId, slug: prodSlug });
    await send(`/admin/products/${p.id}`, "DELETE", {
      expectedUpdatedAt: p.updatedAt,
      confirmConsequences: true,
    });

    const { res, body } = await send(`/admin/products/${p.id}/restore`, "POST", {});
    expect(res.status).toBe(200);
    expect(body.archived).toBe(false);
    expect(body.categoryId).toBe(catId);

    const db = getDb();
    const redirs = await db
      .select()
      .from(schema.redirects)
      .where(eq(schema.redirects.sourcePath, `/products/${catSlug}/${prodSlug}`));
    expect(redirs).toHaveLength(0);
  });

  it("re-homes to uncategorised when the category is gone at restore time", async () => {
    const catId = await insertCategory(uniq("gonecat"));
    const { body: p } = await createProduct({ categoryId: catId });
    await send(`/admin/products/${p.id}`, "DELETE", {
      expectedUpdatedAt: p.updatedAt,
      confirmConsequences: true,
    });
    // Soft-delete the category out from under it (simulating a cascade delete).
    const db = getDb();
    await db
      .update(schema.categories)
      .set({ deletedAt: new Date() })
      .where(eq(schema.categories.id, catId));

    const { body } = await send(`/admin/products/${p.id}/restore`, "POST", {});
    expect(body.archived).toBe(false);
    expect(body.categoryId).toBeNull();
  });

  it("returns 404 restoring a product that is not archived", async () => {
    const { body: p } = await createProduct();
    const { res } = await send(`/admin/products/${p.id}/restore`, "POST", {});
    expect(res.status).toBe(404);
  });
});
