/**
 * Types for the admin archive client (lib/admin/archive/client.ts) — the
 * recovery screen that un-mocks the former mock-data page (roadmap item 51).
 *
 * The wire DTOs (`ArchiveOverview` = soft-deleted products + categories +
 * catalog backups; `ManualBackupResult` = the row an on-demand backup writes)
 * are the concrete Zod-inferred types re-exported from `@shop/api` — same
 * convention as the other admin slices, so the contract has one definition,
 * server-side. The error type is frontend-owned.
 */

export type { ArchiveOverview, ManualBackupResult } from "@shop/api";

/**
 * A flat 404 on the OVERVIEW means the admin session is gone (the whole admin
 * surface collapses to 404 for non-admins) → `router.refresh()`. On a restore
 * ACTION a 404 instead means the item is no longer archived (already restored in
 * another tab) → reload the list. `conflict` is the category-restore 409 (a live
 * sibling now holds that slug); `backups_unavailable` / `backup_failed` are the
 * manual-backup 503 / 502.
 */
export type AdminArchiveError =
  | { kind: "not_admin" }
  | { kind: "not_found" }
  | { kind: "conflict"; detail?: string }
  | { kind: "backups_unavailable" }
  | { kind: "backup_failed" }
  | { kind: "network"; cause: unknown }
  | { kind: "unknown"; status: number; detail?: string };

export type AdminArchiveResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AdminArchiveError };
