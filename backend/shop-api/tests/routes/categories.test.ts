import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { seedCategory } from "../fixtures.js";

let app: ReturnType<typeof buildApp>;

beforeAll(() => {
  app = buildApp();
});

/**
 * Same approach as products.test.ts: tests are HTTP-level via app.request().
 * Fixtures seeded explicitly per test, since per-test.ts truncated everything.
 */

describe("GET /categories", () => {
  it("returns an empty tree when there are no categories", async () => {
    const res = await app.request("/categories");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/s-maxage=300/);
    expect(res.headers.get("vary")).toContain("Accept-Encoding");
    const body = (await res.json()) as { items: unknown[] };
    expect(body).toEqual({ items: [] });
  });

  it("assembles roots and their children, ordered by displayOrder then name", async () => {
    // Roots — created out of displayOrder so we know the API is the one sorting.
    const home = await seedCategory({ slug: "home", name: "Дом", displayOrder: 2 });
    const electronics = await seedCategory({
      slug: "electronics",
      name: "Електроника",
      displayOrder: 0,
    });
    await seedCategory({ slug: "tools", name: "Инструменти", displayOrder: 1 });

    // Electronics children — phones first (displayOrder 0), laptops second (1).
    const phones = await seedCategory({
      slug: "phones",
      name: "Телефони",
      parentId: electronics.id,
      displayOrder: 0,
    });
    await seedCategory({
      slug: "laptops",
      name: "Лаптопи",
      parentId: electronics.id,
      displayOrder: 1,
    });
    // Grandchild under phones.
    await seedCategory({
      slug: "smartphones",
      name: "Смартфони",
      parentId: phones.id,
      displayOrder: 0,
    });
    // Home subcategory.
    await seedCategory({
      slug: "decor",
      name: "Декорация",
      parentId: home.id,
      displayOrder: 0,
    });

    const res = await app.request("/categories");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        slug: string;
        name: string;
        children: Array<{ slug: string; children: Array<{ slug: string }> }>;
      }>;
    };

    // Roots in displayOrder 0,1,2 → electronics, tools, home.
    expect(body.items.map((c) => c.slug)).toEqual([
      "electronics",
      "tools",
      "home",
    ]);

    // Electronics has phones and laptops in display order 0,1.
    const electronicsNode = body.items.find((c) => c.slug === "electronics")!;
    expect(electronicsNode.children.map((c) => c.slug)).toEqual([
      "phones",
      "laptops",
    ]);

    // Tools has no children.
    const toolsNode = body.items.find((c) => c.slug === "tools")!;
    expect(toolsNode.children).toEqual([]);

    // Phones → smartphones (depth 2).
    const phonesNode = electronicsNode.children.find((c) => c.slug === "phones")!;
    expect(phonesNode.children.map((c) => c.slug)).toEqual(["smartphones"]);

    // Home → decor.
    const homeNode = body.items.find((c) => c.slug === "home")!;
    expect(homeNode.children.map((c) => c.slug)).toEqual(["decor"]);
  });

  it("excludes soft-deleted categories from the tree", async () => {
    const electronics = await seedCategory({
      slug: "electronics",
      name: "Електроника",
    });
    const phones = await seedCategory({
      slug: "phones",
      name: "Телефони",
      parentId: electronics.id,
    });
    // Soft-delete the child.
    const { schema } = await import("@shop/db");
    const { eq } = await import("drizzle-orm");
    const { getDb } = await import("../../src/lib/db.js");
    await getDb()
      .update(schema.categories)
      .set({ deletedAt: new Date() })
      .where(eq(schema.categories.id, phones.id));

    const res = await app.request("/categories");
    const body = (await res.json()) as {
      items: Array<{ slug: string; children: Array<{ slug: string }> }>;
    };
    const electronicsNode = body.items.find((c) => c.slug === "electronics")!;
    expect(electronicsNode.children).toEqual([]);
  });

  it("returns the canonical node shape with imageUrl null when no image is set", async () => {
    await seedCategory({ slug: "electronics", name: "Електроника" });
    const res = await app.request("/categories");
    const body = (await res.json()) as {
      items: Array<{
        id: string;
        slug: string;
        name: string;
        imageUrl: string | null;
        displayOrder: number;
        children: unknown[];
      }>;
    };
    const node = body.items[0]!;
    expect(node).toMatchObject({
      slug: "electronics",
      name: "Електроника",
      imageUrl: null,
      displayOrder: 0,
      children: [],
    });
    // id is a UUID
    expect(node.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("returns 304 on conditional GET when ETag matches", async () => {
    await seedCategory({ slug: "electronics", name: "Електроника" });
    const first = await app.request("/categories");
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    const second = await app.request("/categories", {
      headers: { "If-None-Match": etag! },
    });
    expect(second.status).toBe(304);
  });

  it("changes the ETag when the tree changes", async () => {
    await seedCategory({ slug: "electronics", name: "Електроника" });
    const first = await app.request("/categories");
    const etag1 = first.headers.get("etag");

    await seedCategory({ slug: "tools", name: "Инструменти", displayOrder: 1 });
    const second = await app.request("/categories");
    const etag2 = second.headers.get("etag");

    expect(etag1).toBeTruthy();
    expect(etag2).toBeTruthy();
    expect(etag1).not.toBe(etag2);
  });
});

describe("/openapi.json includes categories", () => {
  it("registers GET /categories in the OpenAPI 3.1 spec with the CategoryNode component", async () => {
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);
    const spec = (await res.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };
    expect(spec.openapi).toMatch(/^3\.1/);
    expect(spec.paths).toHaveProperty("/categories");
    expect(spec.components.schemas).toHaveProperty("CategoryNode");
    expect(spec.components.schemas).toHaveProperty("CategoryTree");
  });
});
