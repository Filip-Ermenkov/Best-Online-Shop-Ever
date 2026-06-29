/**
 * Types for the admin banner-management client (lib/admin/banners/client.ts),
 * the fourth admin CRUD slice (un-mocks the homepage hero).
 *
 * The DTO shapes (`AdminBannerSlide`, `AdminBannerList`) are the concrete
 * Zod-inferred types re-exported from `@shop/api` (src/types.ts) — same
 * convention as lib/admin/categories / products / orders, so the wire contract
 * has exactly one definition, server-side. The request-body and error types are
 * frontend-owned and mirror the backend's Zod request schemas and its RFC 9457
 * problem `type`s (backend/shop-api/src/routes/admin/banners.ts).
 */

export type { AdminBannerSlide, AdminBannerList } from "@shop/api";

/** Body for `POST /admin/banners`. */
export interface BannerCreateInput {
  /** The `storedKey` from the upload pipeline (e.g. `banners/<uuid>.jpg`). */
  imageS3Key: string;
  title?: string | null;
  subtitle?: string | null;
  /** Same-origin internal path only (validated server-side). */
  linkUrl?: string | null;
  isActive?: boolean;
}

/**
 * Body for `PATCH /admin/banners/:id`. `expectedUpdatedAt` is the optimistic-
 * lock token (the `updatedAt` the editor rendered from). Any omitted field is
 * left untouched; the toggle just sends `{ expectedUpdatedAt, isActive }`.
 */
export interface BannerUpdateInput {
  expectedUpdatedAt: string;
  imageS3Key?: string;
  title?: string | null;
  subtitle?: string | null;
  linkUrl?: string | null;
  isActive?: boolean;
}

/** Body for `POST /admin/banners/reorder`. */
export interface BannerReorderInput {
  /** The slide ids in their new order — must be exactly the current set. */
  orderedIds: string[];
}

/** Result of `DELETE /admin/banners/:id`. */
export interface BannerDeleteResult {
  deleted: boolean;
}

/**
 * Discriminated error union across every `/admin/banners/*` call. Mirrors the
 * backend's RFC 9457 problem `type`s. `not_admin` (a plain 404 with no
 * banner-specific `type`) means the admin session is gone → the UI does
 * `router.refresh()` so the admin layout re-renders the auth gate.
 */
export type AdminBannersError =
  | { kind: "banner_not_found" }
  | { kind: "not_admin" }
  | { kind: "version_conflict"; detail?: string }
  | { kind: "reorder_mismatch"; detail?: string }
  | { kind: "validation"; fields: { path: string; message: string }[]; detail?: string }
  | { kind: "network"; cause: unknown }
  | { kind: "unknown"; status: number; detail?: string };

export type AdminBannersResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AdminBannersError };
