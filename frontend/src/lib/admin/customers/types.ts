/**
 * Types for the admin account-management client (lib/admin/customers/client.ts),
 * the sixth admin CRUD slice (un-mocks /admin/customers; activates the write side
 * of the `discounts` table — spec §10 „Управление на акаунти" + §11 „Отстъпки").
 *
 * The wire DTOs (`AdminCustomerSummary`, `AdminCustomerList`,
 * `AdminCustomerDetail`, `AdminCustomerDiscount`) are the concrete Zod-inferred
 * types re-exported from `@shop/api` (src/types.ts) — one definition, server-side,
 * same convention as the other admin slices. The filter, request-body and error
 * types are frontend-owned and mirror the backend's Zod request schemas and its
 * RFC 9457 problem `type`s (backend/shop-api/src/routes/admin/customers.ts).
 */

export type {
  AdminCustomerSummary,
  AdminCustomerList,
  AdminCustomerDetail,
  AdminCustomerDiscount,
} from "@shop/api";

/** Query params for `GET /admin/customers`. */
export interface CustomerListFilters {
  q?: string;
  accountType?: "personal" | "corporate";
  hasDiscount?: "true" | "false";
  page?: number;
}

/** Body for `PUT /admin/customers/:id/discount`. `expectedAppliedAt` is the
 * optimistic-lock token (the discount's `appliedAt` the screen rendered from, or
 * null when the screen showed no discount). */
export interface SetDiscountInput {
  percent: number;
  expectedAppliedAt?: string | null;
}

/**
 * Discriminated error union across the `/admin/customers` calls. Mirrors the
 * backend's RFC 9457 problem `type`s. A plain 404 (no `customer-not-found` type)
 * means the admin session is gone → the UI does `router.refresh()` so the admin
 * layout re-renders the auth gate (same contract as the other admin managers).
 */
export type AdminCustomersError =
  | { kind: "not_admin" }
  | { kind: "not_found" }
  | { kind: "version_conflict"; detail?: string }
  | { kind: "active_orders"; orderNumbers: string[]; detail?: string }
  | { kind: "validation"; fields: { path: string; message: string }[]; detail?: string }
  | { kind: "network"; cause: unknown }
  | { kind: "unknown"; status: number; detail?: string };

export type AdminCustomersResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AdminCustomersError };
