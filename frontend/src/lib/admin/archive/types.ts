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

export type {
  ArchiveOverview,
  ManualBackupResult,
  CatalogRestorePlan,
  CatalogRestoreResult,
} from "@shop/api";

/**
 * A flat 404 on the OVERVIEW means the admin session is gone (the whole admin
 * surface collapses to 404 for non-admins) → `router.refresh()`. On a restore
 * ACTION a 404 instead means the item is no longer archived (already restored in
 * another tab) → reload the list. `conflict` is the category-restore 409 (a live
 * sibling now holds that slug); `backups_unavailable` / `backup_failed` are the
 * manual-backup 503 / 502.
 *
 * Snapshot restore (roadmap item 52) adds: `snapshot_invalid` (422 — the stored
 * object is not a valid snapshot), `restore_failed` (502 — the snapshot could
 * not be read, or the pre-restore safety backup failed), and `restore_confirm`
 * (400 — the typed „ВЪЗСТАНОВИ" confirmation was missing/wrong; the UI prevents
 * this, so it is a defensive mapping).
 */
export type AdminArchiveError =
  | { kind: "not_admin" }
  | { kind: "not_found" }
  | { kind: "conflict"; detail?: string }
  | { kind: "backups_unavailable" }
  | { kind: "backup_failed" }
  | { kind: "snapshot_invalid" }
  | { kind: "restore_failed" }
  | { kind: "restore_confirm" }
  | { kind: "network"; cause: unknown }
  | { kind: "unknown"; status: number; detail?: string };

export type AdminArchiveResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AdminArchiveError };
