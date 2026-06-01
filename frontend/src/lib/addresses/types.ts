import type { Address } from "@shop/api";

/**
 * Address-book types for the frontend.
 *
 * `Address` is the concrete Zod-inferred DTO re-exported from `@shop/api`
 * (see backend/shop-api/src/types.ts → routes/addresses.ts). We import the
 * shape rather than hand-rolling it so the wire contract has a single source
 * of truth — the same posture `lib/api.ts` uses for the catalog DTOs, and
 * safe against the workspace-symlink AppType collapse because it's a shallow
 * `z.infer` type (only zod + the one route file participate).
 */
export type { Address };

/**
 * Body for creating an address. Mirrors the backend `CreateAddressRequest`
 * Zod schema. `label` / `apartmentOrOffice` are optional. The backend
 * validates the postal code as exactly four Bulgarian digits and trims every
 * string field server-side.
 */
export interface CreateAddressInput {
  label?: string | null;
  city: string;
  postalCode: string;
  street: string;
  apartmentOrOffice?: string | null;
}

/**
 * Body for a partial update (PATCH). Every field optional; `label` and
 * `apartmentOrOffice` accept an explicit null to clear them.
 */
export type UpdateAddressInput = Partial<CreateAddressInput>;

/**
 * Discriminated error union for the address-book calls. Mirrors the auth
 * module's pattern so the page can branch exhaustively at the type level.
 */
export type AddressError =
  | {
      kind: "validation";
      fields: { path: string; message: string }[];
      detail?: string;
    }
  /** Address not found / not yours / already removed — all collapse to one 404. */
  | { kind: "not_found"; detail?: string }
  /** The per-user address-book cap (20) was hit on create. Backend 422. */
  | { kind: "limit_reached"; detail?: string }
  /** Session died between page load and the request. */
  | { kind: "unauthenticated" }
  | { kind: "network"; cause: unknown }
  | { kind: "unknown"; status: number; detail?: string };

export type AddressResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AddressError };
