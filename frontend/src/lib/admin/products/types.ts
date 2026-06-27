/**
 * Types for the admin product-management client (lib/admin/products/client.ts).
 *
 * The DTO shapes (`AdminProductSummary`, `AdminProductDetail`, `AdminProductList`)
 * are the concrete Zod-inferred types re-exported from `@shop/api` (src/types.ts)
 * — same convention as lib/admin/categories and lib/admin/orders, so the wire
 * contract has exactly one definition, server-side. The request-body and error
 * types are frontend-owned and mirror the backend's Zod request schemas and its
 * RFC 9457 problem `type`s (backend/shop-api/src/routes/admin/products.ts).
 */

export type {
  AdminProductSummary,
  AdminProductDetail,
  AdminProductList,
} from "@shop/api";

/** Stock status — mirrors the backend `AdminStockStatus` enum. */
export type AdminStockStatus = "in_stock" | "out_of_stock";

/** Sort order accepted by `GET /admin/products?sort=`. */
export type AdminProductSort =
  | "newest"
  | "oldest"
  | "price_asc"
  | "price_desc"
  | "name";

/** Archive filter accepted by `GET /admin/products?status=`. */
export type AdminProductStatusFilter = "active" | "archived" | "all";

/** Query for `GET /admin/products` (mirror of the backend `ListQuerySchema`). */
export interface AdminProductListQuery {
  page?: number;
  pageSize?: number;
  status?: AdminProductStatusFilter;
  categoryId?: string;
  stockStatus?: AdminStockStatus;
  /** Free-text search across name + SKU. */
  q?: string;
  sort?: AdminProductSort;
}

/**
 * One image in a create/update payload, in display order. The `s3Key` is the
 * `storedKey` the upload pipeline returns (lib/uploads/client.ts) — or, when
 * uploads are not configured on the deployment, a manually-entered key.
 */
export interface ProductImageInput {
  s3Key: string;
  altText?: string;
}

/** Body for `POST /admin/products`. */
export interface ProductCreateInput {
  name: string;
  code: string;
  /** Omit to let the API derive it from `name` (Bulgarian→Latin). */
  slug?: string;
  description?: string;
  /** Integer minor units (cents). */
  priceCents: number;
  currency?: string;
  /** null / omitted = uncategorised. */
  categoryId?: string | null;
  stockStatus?: AdminStockStatus;
  /** omit → 30-day "NEW" badge; `null` → no badge; ISO instant → lit until then. */
  newUntil?: string | null;
  images?: ProductImageInput[];
}

/**
 * Body for `PATCH /admin/products/:id`. `expectedUpdatedAt` is the optimistic-
 * lock token (the `updatedAt` the editor rendered from). `images`, when present,
 * replaces the whole ordered set; `[]` clears it; omitting it leaves it untouched.
 */
export interface ProductUpdateInput {
  expectedUpdatedAt: string;
  name?: string;
  code?: string;
  slug?: string;
  description?: string;
  priceCents?: number;
  currency?: string;
  categoryId?: string | null;
  stockStatus?: AdminStockStatus;
  newUntil?: string | null;
  images?: ProductImageInput[];
}

/** Body for `POST /admin/products/reorder`. */
export interface ProductReorderInput {
  /** The category layer being reordered. null = the uncategorised layer. */
  categoryId: string | null;
  /** The product ids in their new order — must be exactly that layer's live set. */
  orderedIds: string[];
}

/** Result of `DELETE /admin/products/:id`. */
export interface ProductDeleteResult {
  archived: boolean;
  redirectsWritten: number;
}

/** Result of `POST /admin/products/reorder`. */
export interface ProductReorderResult {
  reordered: number;
}

/**
 * Discriminated error union across every `/admin/products/*` call. Mirrors the
 * backend's RFC 9457 problem `type`s.
 *
 * `not_admin` mirrors the categories/orders clients: a plain 404 with no
 * `/problems/product-not-found` type means the admin session is gone, and the
 * UI's correct move is `router.refresh()` so the admin layout re-renders the
 * auth gate.
 */
export type AdminProductsError =
  | { kind: "product_not_found" }
  | { kind: "not_admin" }
  | { kind: "slug_conflict"; detail?: string }
  | { kind: "code_conflict"; detail?: string }
  | { kind: "version_conflict"; detail?: string }
  | { kind: "reorder_mismatch"; detail?: string }
  | { kind: "validation"; fields: { path: string; message: string }[]; detail?: string }
  | { kind: "network"; cause: unknown }
  | { kind: "unknown"; status: number; detail?: string };

export type AdminProductsResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AdminProductsError };
