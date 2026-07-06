/**
 * Types for the admin dashboard client (lib/admin/dashboard/client.ts) — the
 * read-only `/admin` landing screen that un-mocks the former mock-data tiles.
 *
 * The DTO (`DashboardSummary` = sales KPIs + action queue + catalog snapshot +
 * recent orders + the 14-day trend) is the concrete Zod-inferred type re-exported
 * from `@shop/api` (src/types.ts) — same convention as the other admin slices, so
 * the wire contract has exactly one definition, server-side. The error type is
 * frontend-owned; the surface is read-only, so a flat 404 (`not_admin`, the whole
 * admin API's uniform "no admin session") is the only meaningful failure besides
 * the network / unexpected cases.
 */

export type { DashboardSummary } from "@shop/api";

/**
 * A flat 404 means the admin session is gone (the whole admin surface collapses
 * to 404 for non-admins) → the UI does `router.refresh()` so the admin layout
 * re-renders the auth gate, exactly like the other admin managers.
 */
export type AdminDashboardError =
  | { kind: "not_admin" }
  | { kind: "network"; cause: unknown }
  | { kind: "unknown"; status: number; detail?: string };

export type AdminDashboardResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AdminDashboardError };
