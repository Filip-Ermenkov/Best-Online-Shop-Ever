/**
 * Types for the admin order-management client (lib/admin/orders/client.ts).
 *
 * The DTO shapes are the concrete Zod-inferred types re-exported from
 * `@shop/api` (src/types.ts) — same convention as lib/orders / lib/addresses,
 * so the wire contract has exactly one definition, server-side. The error
 * union is frontend-owned and mirrors the RFC 9457 problem types the
 * `/admin/orders/*` routes emit.
 */

export type {
  AdminOrderSummary,
  AdminOrdersPage,
  AdminOrderDetail,
  AdminOrderStatusHistoryEntry,
  OrderStatus,
  TransitionTarget,
} from "@shop/api";

import type { OrderStatus, TransitionTarget } from "@shop/api";

/** Filters for the list + CSV export (mirror of the backend query schema). */
export interface AdminOrdersFilters {
  page?: number;
  pageSize?: number;
  status?: OrderStatus;
  paymentMethod?: "cash_on_delivery" | "pay_at_store";
  customerType?: "guest" | "personal" | "corporate";
  q?: string;
  /** YYYY-MM-DD (Europe/Sofia calendar date), inclusive. */
  from?: string;
  /** YYYY-MM-DD (Europe/Sofia calendar date), inclusive. */
  to?: string;
}

/** Body for POST /admin/orders/:orderNumber/status. */
export interface AdminOrderTransitionInput {
  status: TransitionTarget;
  expectedVersion: number;
  courierCompany?: string;
  trackingNumber?: string;
  /** ISO 8601 instant; required for ready_for_pickup. */
  pickupDeadline?: string;
  cancelledReason?: string;
  note?: string;
}

/**
 * Discriminated error union across every /admin/orders/* call.
 *
 * `not_admin` deserves a note: the admin surface answers a uniform 404 when
 * the session is missing/expired/non-admin (enumeration resistance), and the
 * routes use `/problems/order-not-found` for a genuinely unknown order — so
 * a 404 WITHOUT that problem type means "session gone", and the UI's correct
 * move is `router.refresh()` to let the admin layout re-render the auth gate.
 */
export type AdminOrdersError =
  /** 404 with /problems/order-not-found — the order number does not exist. */
  | { kind: "order_not_found" }
  /** Plain 404 — no admin session (expired / signed out in another tab). */
  | { kind: "not_admin" }
  /** 409 /problems/invalid-status-transition — stale buttons; refetch. */
  | { kind: "invalid_transition"; detail?: string }
  /** 409 /problems/order-version-conflict — concurrent edit; refetch. */
  | { kind: "version_conflict"; detail?: string }
  /** 400 — bad/missing companion fields for the chosen target. */
  | { kind: "validation"; fields: { path: string; message: string }[]; detail?: string }
  /** Transport failure (API unreachable). */
  | { kind: "network"; cause: unknown }
  | { kind: "unknown"; status: number; detail?: string };

export type AdminOrdersResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AdminOrdersError };
