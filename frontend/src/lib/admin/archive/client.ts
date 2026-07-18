/**
 * Browser-side client for the admin archive API (`/admin/archive` +
 * `/admin/archive/backup` on shop-api, plus the two per-entity restore routes
 * `/admin/products/:id/restore` and `/admin/categories/:id/restore` — see the
 * backend routes/admin/{archive,products,categories}.ts).
 *
 * Same transport posture as the other admin clients (dashboard / customers):
 * plain `fetch` against NEXT_PUBLIC_SHOP_API_URL with `credentials: "include"`
 * so the admin session cookie rides along, `cache: "no-store"` (an archive must
 * reflect live state), and RFC 9457 `application/problem+json` responses mapped
 * into the typed `AdminArchiveError` union.
 */
import type {
  AdminArchiveError,
  AdminArchiveResult,
  ArchiveOverview,
  CatalogRestorePlan,
  CatalogRestoreResult,
  ManualBackupResult,
} from "./types";

const baseUrl =
  process.env.NEXT_PUBLIC_SHOP_API_URL?.replace(/\/+$/, "") ??
  "http://localhost:3001";

interface ProblemResponse {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
}

async function readProblem(res: Response): Promise<ProblemResponse | undefined> {
  try {
    return (await res.json()) as ProblemResponse;
  } catch {
    return undefined;
  }
}

function unknownError(status: number, problem?: ProblemResponse): AdminArchiveError {
  return { kind: "unknown", status, detail: problem?.detail };
}

/** The whole overview — soft-deleted lists + the backups list + availability. */
export async function fetchAdminArchive(): Promise<AdminArchiveResult<ArchiveOverview>> {
  try {
    const res = await fetch(`${baseUrl}/admin/archive`, {
      credentials: "include",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (res.ok) return { ok: true, value: (await res.json()) as ArchiveOverview };
    // No "overview not found" exists — a 404 is the surface's uniform "no admin".
    if (res.status === 404) return { ok: false, error: { kind: "not_admin" } };
    return { ok: false, error: unknownError(res.status, await readProblem(res)) };
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}

export async function restoreArchivedProduct(
  id: string,
): Promise<AdminArchiveResult<void>> {
  try {
    const res = await fetch(`${baseUrl}/admin/products/${id}/restore`, {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (res.ok) return { ok: true, value: undefined };
    // On an action, 404 means "already restored / gone" — the caller reloads,
    // and that reload's own 404 (if any) is what surfaces an expired session.
    if (res.status === 404) return { ok: false, error: { kind: "not_found" } };
    return { ok: false, error: unknownError(res.status, await readProblem(res)) };
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}

export async function restoreArchivedCategory(
  id: string,
): Promise<AdminArchiveResult<void>> {
  try {
    const res = await fetch(`${baseUrl}/admin/categories/${id}/restore`, {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (res.ok) return { ok: true, value: undefined };
    if (res.status === 409) {
      return { ok: false, error: { kind: "conflict", detail: (await readProblem(res))?.detail } };
    }
    if (res.status === 404) return { ok: false, error: { kind: "not_found" } };
    return { ok: false, error: unknownError(res.status, await readProblem(res)) };
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}

/** Trigger an on-demand („Ръчно") catalog backup. */
export async function triggerManualBackup(): Promise<
  AdminArchiveResult<ManualBackupResult>
> {
  try {
    const res = await fetch(`${baseUrl}/admin/archive/backup`, {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (res.ok) return { ok: true, value: (await res.json()) as ManualBackupResult };
    if (res.status === 503) return { ok: false, error: { kind: "backups_unavailable" } };
    if (res.status === 502) return { ok: false, error: { kind: "backup_failed" } };
    if (res.status === 404) return { ok: false, error: { kind: "not_admin" } };
    return { ok: false, error: unknownError(res.status, await readProblem(res)) };
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}

/**
 * Dry-run diff: what restoring this snapshot over the live catalog WOULD do
 * (roadmap item 52). Side-effect-free — used to populate the confirm dialog
 * before the admin types „ВЪЗСТАНОВИ". A 404 here means the backup is gone (or
 * the session expired); the dialog closes and the caller reloads the overview.
 */
export async function previewSnapshotRestore(
  backupId: string,
): Promise<AdminArchiveResult<CatalogRestorePlan>> {
  try {
    const res = await fetch(
      `${baseUrl}/admin/archive/backups/${backupId}/preview`,
      {
        credentials: "include",
        headers: { Accept: "application/json" },
        cache: "no-store",
      },
    );
    if (res.ok) return { ok: true, value: (await res.json()) as CatalogRestorePlan };
    if (res.status === 503) return { ok: false, error: { kind: "backups_unavailable" } };
    if (res.status === 502) return { ok: false, error: { kind: "restore_failed" } };
    if (res.status === 422) return { ok: false, error: { kind: "snapshot_invalid" } };
    if (res.status === 404) return { ok: false, error: { kind: "not_found" } };
    return { ok: false, error: unknownError(res.status, await readProblem(res)) };
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}

/**
 * Replay a snapshot over the live catalog — the destructive restore (roadmap
 * item 52). `confirm` is the phrase the admin typed; the server re-checks it
 * (must equal „ВЪЗСТАНОВИ") so a malformed client still can't fire it. On
 * success the response carries the applied plan and the auto-taken pre-restore
 * safety backup (the rollback point).
 */
export async function restoreSnapshot(
  backupId: string,
  confirm: string,
): Promise<AdminArchiveResult<CatalogRestoreResult>> {
  try {
    const res = await fetch(
      `${baseUrl}/admin/archive/backups/${backupId}/restore`,
      {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ confirm }),
      },
    );
    if (res.ok) return { ok: true, value: (await res.json()) as CatalogRestoreResult };
    if (res.status === 503) return { ok: false, error: { kind: "backups_unavailable" } };
    if (res.status === 502) return { ok: false, error: { kind: "restore_failed" } };
    if (res.status === 422) return { ok: false, error: { kind: "snapshot_invalid" } };
    if (res.status === 400) return { ok: false, error: { kind: "restore_confirm" } };
    if (res.status === 404) return { ok: false, error: { kind: "not_found" } };
    return { ok: false, error: unknownError(res.status, await readProblem(res)) };
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}
