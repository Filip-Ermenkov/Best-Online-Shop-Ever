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
