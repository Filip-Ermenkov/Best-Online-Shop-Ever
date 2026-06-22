import { describe, expect, it } from "vitest";
import {
  DEFAULT_NEW_FOR_DAYS,
  MAX_PRODUCT_IMAGES,
  defaultNewUntil,
  normalizeImages,
  productCanonicalPath,
  resolveNewUntil,
  resolveProductSlug,
} from "../../src/lib/product-admin.js";

/**
 * Pure-unit tests for the admin product helpers (no DB, no Hono). These cover
 * the parts with the most edge cases: slug resolution (derive vs explicit),
 * image-list normalisation (trim / dedup / cap / order), the canonical-URL
 * builder used for the soft-delete redirect, and the three-way new_until
 * resolution (undefined / null / ISO).
 */

describe("resolveProductSlug", () => {
  it("derives a latin slug from a Bulgarian name", () => {
    expect(resolveProductSlug("Телефон Самсунг")).toBe("telefon-samsung");
  });

  it("returns a valid explicit slug verbatim (trimmed)", () => {
    expect(resolveProductSlug("Anything", "  samsung-a55  ")).toBe("samsung-a55");
  });

  it("rejects an invalid explicit slug", () => {
    expect(resolveProductSlug("Anything", "Bad Slug!")).toBeNull();
    expect(resolveProductSlug("Anything", "UPPER")).toBeNull();
  });

  it("derives from the name when explicit is empty/undefined/null", () => {
    expect(resolveProductSlug("Hello World")).toBe("hello-world");
    expect(resolveProductSlug("Hello World", "")).toBe("hello-world");
    expect(resolveProductSlug("Hello World", null)).toBe("hello-world");
  });

  it("returns null when the name cannot produce a slug", () => {
    expect(resolveProductSlug("!!!")).toBeNull();
    expect(resolveProductSlug("   ")).toBeNull();
  });
});

describe("normalizeImages", () => {
  it("returns null for undefined (leave the set untouched)", () => {
    expect(normalizeImages(undefined)).toBeNull();
  });

  it("returns [] for an explicit empty array (clear the set)", () => {
    expect(normalizeImages([])).toEqual([]);
  });

  it("trims keys, drops blanks, and assigns a dense displayOrder", () => {
    const out = normalizeImages([
      { s3Key: "  products/a.jpg  ", altText: "  A  " },
      { s3Key: "   " },
      { s3Key: "products/b.jpg" },
    ]);
    expect(out).toEqual([
      { s3Key: "products/a.jpg", altText: "A", displayOrder: 0 },
      { s3Key: "products/b.jpg", altText: "", displayOrder: 1 },
    ]);
  });

  it("de-duplicates by s3Key, first occurrence wins", () => {
    const out = normalizeImages([
      { s3Key: "products/a.jpg", altText: "first" },
      { s3Key: "products/a.jpg", altText: "dup" },
      { s3Key: "products/b.jpg" },
    ]);
    expect(out).toHaveLength(2);
    expect(out![0]).toEqual({ s3Key: "products/a.jpg", altText: "first", displayOrder: 0 });
  });

  it("caps the list at the maximum", () => {
    const many = Array.from({ length: MAX_PRODUCT_IMAGES + 5 }, (_, i) => ({
      s3Key: `products/${i}.jpg`,
    }));
    const out = normalizeImages(many);
    expect(out).toHaveLength(MAX_PRODUCT_IMAGES);
    expect(out![MAX_PRODUCT_IMAGES - 1]!.displayOrder).toBe(MAX_PRODUCT_IMAGES - 1);
  });
});

describe("productCanonicalPath", () => {
  it("prefixes the category slug chain", () => {
    expect(productCanonicalPath(["elektronika", "telefoni"], "samsung-a55")).toBe(
      "/products/elektronika/telefoni/samsung-a55",
    );
  });

  it("falls back to the bare slug with no/empty chain", () => {
    expect(productCanonicalPath(null, "samsung-a55")).toBe("/products/samsung-a55");
    expect(productCanonicalPath([], "samsung-a55")).toBe("/products/samsung-a55");
  });
});

describe("defaultNewUntil", () => {
  it("returns now + 30 days by default", () => {
    const now = new Date("2026-06-22T00:00:00.000Z");
    const out = defaultNewUntil(now);
    expect(out.toISOString()).toBe("2026-07-22T00:00:00.000Z");
    expect(DEFAULT_NEW_FOR_DAYS).toBe(30);
  });
});

describe("resolveNewUntil", () => {
  it("maps undefined → undefined (caller decides)", () => {
    expect(resolveNewUntil(undefined)).toBeUndefined();
  });

  it("maps null → null (clear the badge)", () => {
    expect(resolveNewUntil(null)).toBeNull();
  });

  it("maps a valid ISO string → Date", () => {
    const out = resolveNewUntil("2026-12-31T23:59:59.000Z");
    expect(out).toBeInstanceOf(Date);
    expect((out as Date).toISOString()).toBe("2026-12-31T23:59:59.000Z");
  });

  it("maps an invalid string → 'invalid'", () => {
    expect(resolveNewUntil("not-a-date")).toBe("invalid");
  });
});
