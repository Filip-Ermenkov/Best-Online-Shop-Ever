/**
 * Types for the admin image-upload client (lib/uploads/client.ts), roadmap
 * item 46.
 *
 * The presign DTOs are the concrete Zod-inferred shapes re-exported from
 * `@shop/api` (src/types.ts) — same convention as lib/admin/categories — so the
 * wire contract has exactly one definition, server-side. The error union is
 * frontend-owned and mirrors the RFC 9457 problems the `/admin/uploads` routes
 * emit, plus the direct-to-S3 failure modes the browser sees on the second hop.
 *
 * One client, three callers: the product, category, and banner editors all
 * upload through `uploadImage(file, kind)` and store the returned key exactly as
 * those routes already accept image keys.
 */

export type { AdminPresignedUpload, AdminUploadStatus } from "@shop/api";

/** Which catalog entity an image is for — selects the S3 key folder. */
export type UploadKind = "products" | "categories" | "banners";

/** The outcome of a successful upload: the key to persist + its eventual URL. */
export interface UploadedImage {
  /** Save this on the product/category/banner (e.g. `products/<uuid>.jpg`). */
  storedKey: string;
  /** The CDN URL the key resolves to once the validator promotes it. */
  publicUrl: string;
}

export type UploadError =
  /** No admin session (the surface returns a uniform 404). */
  | { kind: "not_admin" }
  /** Uploads are not configured on this deployment (503). */
  | { kind: "not_configured" }
  /** Disallowed type, over-cap size, or unknown kind (400). */
  | { kind: "validation"; fields: { path: string; message: string }[]; detail?: string }
  /** The direct S3 POST was refused (policy mismatch) or failed. */
  | { kind: "s3_rejected"; status: number }
  /** A transport/network error on either hop. */
  | { kind: "network"; detail?: string }
  | { kind: "unknown"; status?: number; detail?: string };

export type UploadResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: UploadError };
