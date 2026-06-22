/**
 * Pure helpers for the admin product-management route (routes/admin/products.ts)
 * — no DB, no I/O, no Hono. Same split @shop/auth uses for crypto,
 * lib/order-status.ts for the order state machine, and lib/category-tree.ts for
 * the category traversals: keeping the parts with the most edge cases pure means
 * they unit-test in isolation (tests/lib/product-admin.test.ts) and the same
 * logic can serve a future admin-api Lambda without dragging route wiring along.
 *
 * The data model is deliberately SINGLE-SKU: one `code` (SKU) per product, no
 * variant/option matrix. For a small Bulgarian catalog that is the correct,
 * simplest model — "when a product has no variations, SKU and product are one
 * and the same". Introducing a `product_variants` child table is a documented
 * future door (docs/ARCHITECTURE.md §16), to be opened only when a real
 * size/colour requirement appears, exactly like the search and multi-tenant
 * doors. SKU values are treated as stable identifiers (see resolveProductSlug /
 * the uniqueness checks in the route, which span soft-deleted rows too).
 */

import { isValidSlug, productUrl, slugify } from "./category-tree.js";

/** Max images we let an admin attach to one product. */
export const MAX_PRODUCT_IMAGES = 12;

/** Default number of days the "NEW" badge stays lit after creation. */
export const DEFAULT_NEW_FOR_DAYS = 30;

/**
 * Resolve the slug for a product. When `explicit` is supplied it must already be
 * a valid slug (the storefront URL grammar — lowercase latin, digits, single
 * hyphens); when omitted the slug is derived from the (possibly Bulgarian) name
 * via the shared `slugify` (byte-identical to the frontend's, so a slug the
 * admin form auto-derives client-side and one the API derives from an omitted
 * field are the same string). Returns null when no valid slug can be produced —
 * the caller turns that into a 400 with a field error.
 */
export function resolveProductSlug(
  name: string,
  explicit?: string | null,
): string | null {
  if (explicit !== undefined && explicit !== null && explicit !== "") {
    const trimmed = explicit.trim();
    return isValidSlug(trimmed) ? trimmed : null;
  }
  const derived = slugify(name);
  return derived && isValidSlug(derived) ? derived : null;
}

export interface NormalizedImage {
  s3Key: string;
  altText: string;
  displayOrder: number;
}

/**
 * Normalise an incoming image list into the persisted shape: trim keys, drop
 * blanks, de-duplicate by s3Key (first occurrence wins — preserves the admin's
 * intended order), cap at MAX_PRODUCT_IMAGES, and assign a dense 0-based
 * displayOrder by position. The lowest displayOrder is the "main" image the
 * storefront uses on cards/cart thumbnails (see routes/products.ts).
 *
 * `undefined` means "the caller did not send an images field" → returns null so
 * the route can leave the existing set untouched on PATCH. An explicit empty
 * array means "remove all images" → returns [].
 */
export function normalizeImages(
  input: { s3Key: string; altText?: string | null }[] | undefined,
  max: number = MAX_PRODUCT_IMAGES,
): NormalizedImage[] | null {
  if (input === undefined) return null;
  const out: NormalizedImage[] = [];
  const seen = new Set<string>();
  for (const img of input) {
    const key = img.s3Key.trim();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      s3Key: key,
      altText: (img.altText ?? "").trim(),
      displayOrder: out.length,
    });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * The canonical storefront URL of a product, used as the `source_path` of the
 * 301 redirect written when the product is soft-deleted. When the product sits
 * under a live category we prefix the full category slug chain (the canonical,
 * category-prefixed form a crawler indexed); with no live category we fall back
 * to the bare `/products/<slug>` the catch-all would otherwise 404.
 */
export function productCanonicalPath(
  categoryChain: string[] | null,
  slug: string,
): string {
  if (categoryChain && categoryChain.length > 0) {
    return productUrl(categoryChain, slug);
  }
  return `/products/${slug}`;
}

/** The default `new_until` for a freshly created product: now + N days. */
export function defaultNewUntil(
  now: Date,
  days: number = DEFAULT_NEW_FOR_DAYS,
): Date {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * Resolve the `new_until` column value from a request field that may be:
 *   - undefined → caller decides (default on create, leave on update),
 *   - null      → clear the badge (no NEW),
 *   - ISO string → that exact instant.
 * Returns the same three-way result typed for a Drizzle column write. Invalid
 * date strings return the literal "invalid" so the caller can raise a 400
 * rather than silently writing a bad timestamp.
 */
export function resolveNewUntil(
  field: string | null | undefined,
): Date | null | undefined | "invalid" {
  if (field === undefined) return undefined;
  if (field === null) return null;
  const ms = Date.parse(field);
  if (Number.isNaN(ms)) return "invalid";
  return new Date(ms);
}
