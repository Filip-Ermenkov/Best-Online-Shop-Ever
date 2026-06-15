/**
 * Types for the admin category-management client (lib/admin/categories/client.ts).
 *
 * The DTO shapes are the concrete Zod-inferred types re-exported from
 * `@shop/api` (src/types.ts) — same convention as lib/admin/orders, so the
 * wire contract has exactly one definition, server-side. The error union is
 * frontend-owned and mirrors the RFC 9457 problem types the
 * `/admin/categories/*` routes emit.
 */

export type {
  AdminCategoryNode,
  AdminCategoryTree,
  AdminCategoryDeletionImpact,
} from "@shop/api";

/** Body for POST /admin/categories. */
export interface CategoryCreateInput {
  name: string;
  /** Omit to let the API derive it from `name` (Bulgarian→Latin). */
  slug?: string;
  /** null / omitted = top-level category. */
  parentId?: string | null;
  imageS3Key?: string | null;
}

/** Body for PATCH /admin/categories/:id. `expectedUpdatedAt` is the lock token. */
export interface CategoryUpdateInput {
  expectedUpdatedAt: string;
  name?: string;
  slug?: string;
  parentId?: string | null;
  imageS3Key?: string | null;
}

/** Body for POST /admin/categories/reorder. */
export interface CategoryReorderInput {
  parentId: string | null;
  orderedIds: string[];
}

/**
 * Discriminated error union across every /admin/categories/* call.
 *
 * `not_admin` mirrors the orders client: a plain 404 (no
 * `/problems/category-not-found` type) means the admin session is gone, and
 * the UI's correct move is `router.refresh()` so the admin layout re-renders
 * the auth gate.
 */
export type AdminCategoriesError =
  | { kind: "category_not_found" }
  | { kind: "not_admin" }
  | { kind: "slug_conflict"; detail?: string }
  | { kind: "version_conflict"; detail?: string }
  | { kind: "move_cycle"; detail?: string }
  | { kind: "reorder_mismatch"; detail?: string }
  | { kind: "validation"; fields: { path: string; message: string }[]; detail?: string }
  | { kind: "network"; cause: unknown }
  | { kind: "unknown"; status: number; detail?: string };

export type AdminCategoriesResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AdminCategoriesError };
