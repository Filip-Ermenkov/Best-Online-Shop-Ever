import { schema } from "@shop/db";
import { getDb } from "../src/lib/db.js";

/**
 * Test data builders. Tests call seedCatalog({...overrides}) for a default
 * shape, or use the lower-level helpers to build exactly what they need.
 *
 * Naming: "Demo*" so logs make it obvious this is test data, never real.
 */

export interface SeedOptions {
  productCount?: number;
}

export async function seedCategory(values: {
  slug: string;
  name: string;
  parentId?: string | null;
  displayOrder?: number;
}) {
  const db = getDb();
  const [row] = await db
    .insert(schema.categories)
    .values({
      slug: values.slug,
      name: values.name,
      parentId: values.parentId ?? null,
      displayOrder: values.displayOrder ?? 0,
    })
    .returning();
  return row!;
}

export async function seedProduct(values: {
  slug: string;
  code: string;
  name: string;
  priceCents: number;
  categoryId?: string | null;
  stockStatus?: "in_stock" | "out_of_stock";
  displayOrder?: number;
  description?: string;
  isNew?: boolean;
}) {
  const db = getDb();
  const [row] = await db
    .insert(schema.products)
    .values({
      slug: values.slug,
      code: values.code,
      name: values.name,
      description: values.description ?? "",
      priceCents: String(values.priceCents),
      categoryId: values.categoryId ?? null,
      stockStatus: values.stockStatus ?? "in_stock",
      displayOrder: values.displayOrder ?? 0,
      newUntil: values.isNew
        ? new Date(Date.now() + 30 * 24 * 3600 * 1000)
        : null,
    })
    .returning();
  return row!;
}

export async function seedImage(values: {
  productId: string;
  s3Key: string;
  altText?: string;
  displayOrder?: number;
}) {
  const db = getDb();
  const [row] = await db
    .insert(schema.productImages)
    .values({
      productId: values.productId,
      s3Key: values.s3Key,
      altText: values.altText ?? "",
      displayOrder: values.displayOrder ?? 0,
    })
    .returning();
  return row!;
}

/** Convenience: 1 root category + 3 products + 1 image each. */
export async function seedSmallCatalog() {
  const cat = await seedCategory({
    slug: "demo-cat",
    name: "Demo Category",
    displayOrder: 0,
  });

  const p1 = await seedProduct({
    slug: "demo-headphones",
    code: "DEMO-001",
    name: "Demo Headphones",
    description: "A demo product.",
    priceCents: 9999,
    categoryId: cat.id,
    displayOrder: 0,
    isNew: true,
  });
  await seedImage({
    productId: p1.id,
    s3Key: "demo/headphones-front.jpg",
    altText: "front",
    displayOrder: 0,
  });
  await seedImage({
    productId: p1.id,
    s3Key: "demo/headphones-back.jpg",
    altText: "back",
    displayOrder: 1,
  });

  const p2 = await seedProduct({
    slug: "demo-watch",
    code: "DEMO-002",
    name: "Demo Watch",
    priceCents: 24999,
    categoryId: cat.id,
    displayOrder: 1,
    stockStatus: "in_stock",
  });
  await seedImage({
    productId: p2.id,
    s3Key: "demo/watch.jpg",
    displayOrder: 0,
  });

  const p3 = await seedProduct({
    slug: "demo-drill",
    code: "DEMO-003",
    name: "Demo Drill",
    priceCents: 5999,
    categoryId: cat.id,
    displayOrder: 2,
    stockStatus: "out_of_stock",
  });
  await seedImage({
    productId: p3.id,
    s3Key: "demo/drill.jpg",
    displayOrder: 0,
  });

  return { cat, p1, p2, p3 };
}
