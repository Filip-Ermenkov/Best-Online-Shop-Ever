/**
 * Types for the admin store-settings client (lib/admin/settings/client.ts), the
 * fifth admin CRUD slice (un-mocks /admin/settings; moves operator config off
 * env onto the runtime-editable settings table).
 *
 * The DTO (`AdminSettings` = every value keyed by registry key + the optimistic-
 * lock `version`) is the concrete Zod-inferred type re-exported from `@shop/api`
 * (src/types.ts) — same convention as the other admin slices, so the wire
 * contract has exactly one definition, server-side. The request-body and error
 * types are frontend-owned and mirror the backend's Zod request schema and its
 * RFC 9457 problem `type`s (backend/shop-api/src/routes/admin/settings.ts).
 */

export type { AdminSettings } from "@shop/api";

/** The editable value shape (registry keys → values). */
export interface SettingsValues {
  default_pickup_deadline_days: number;
  store_address: string;
  store_hours: string;
  store_phone: string;
  store_email: string;
  admin_notification_email: string;
}

/**
 * Body for `PATCH /admin/settings`. `expectedVersion` is the optimistic-lock
 * token (the `version` the form rendered from). Only the changed keys are sent.
 */
export interface SettingsUpdateInput {
  expectedVersion: string;
  values: Partial<SettingsValues>;
}

/**
 * Discriminated error union across the `/admin/settings` calls. Mirrors the
 * backend's RFC 9457 problem `type`s. `not_admin` (a plain 404) means the admin
 * session is gone → the UI does `router.refresh()` so the admin layout
 * re-renders the auth gate (same contract as the other admin managers).
 */
export type AdminSettingsError =
  | { kind: "not_admin" }
  | { kind: "version_conflict"; detail?: string }
  | { kind: "validation"; fields: { path: string; message: string }[]; detail?: string }
  | { kind: "network"; cause: unknown }
  | { kind: "unknown"; status: number; detail?: string };

export type AdminSettingsResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AdminSettingsError };
