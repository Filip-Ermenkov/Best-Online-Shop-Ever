/**
 * Browser-side client for the admin dashboard API (`/admin/dashboard` on
 * shop-api — see backend routes/admin/dashboard.ts).
 *
 * Same transport posture as the other admin clients (settings / customers /
 * banners): plain `fetch` against NEXT_PUBLIC_SHOP_API_URL with
 * `credentials: "include"` so the admin session cookie rides along, `cache:
 * "no-store"` because a dashboard must always reflect live numbers, and RFC 9457
 * `application/problem+json` responses mapped into the typed `AdminDashboardError`
 * union. The wire DTO comes from `@shop/api` (re-exported through ./types).
 */
import type {
  AdminDashboardError,
  AdminDashboardResult,
  DashboardSummary,
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

function classifyError(
  status: number,
  problem?: ProblemResponse,
): AdminDashboardError {
  if (status === 404) {
    // The whole admin surface collapses to 404 for non-admins; a 404 here means
    // "session gone" (there is no dashboard-specific not-found).
    return { kind: "not_admin" };
  }
  return { kind: "unknown", status, detail: problem?.detail };
}

async function map<T>(res: Response): Promise<AdminDashboardResult<T>> {
  if (res.ok) {
    return { ok: true, value: (await res.json()) as T };
  }
  return { ok: false, error: classifyError(res.status, await readProblem(res)) };
}

export async function fetchAdminDashboard(): Promise<
  AdminDashboardResult<DashboardSummary>
> {
  try {
    return await map<DashboardSummary>(
      await fetch(`${baseUrl}/admin/dashboard`, {
        credentials: "include",
        headers: { Accept: "application/json" },
        cache: "no-store",
      }),
    );
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}
