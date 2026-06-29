/**
 * Browser-side client for the admin banner-management API (`/admin/banners/*`
 * on shop-api — see backend routes/admin/banners.ts).
 *
 * Same transport posture as lib/admin/categories|products/client.ts: plain
 * `fetch` against NEXT_PUBLIC_SHOP_API_URL with `credentials: "include"` so the
 * admin session cookie rides along, and RFC 9457 `application/problem+json`
 * responses mapped into the typed `AdminBannersError` union. The wire DTOs come
 * from `@shop/api` (re-exported through ./types).
 */
import type {
  AdminBannerList,
  AdminBannerSlide,
  AdminBannersError,
  AdminBannersResult,
  BannerCreateInput,
  BannerDeleteResult,
  BannerReorderInput,
  BannerUpdateInput,
} from "./types";

const baseUrl =
  process.env.NEXT_PUBLIC_SHOP_API_URL?.replace(/\/+$/, "") ??
  "http://localhost:3001";

interface ProblemResponse {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  errors?: { path: string; message: string }[];
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
): AdminBannersError {
  if (status === 404) {
    return problem?.type === "/problems/banner-not-found"
      ? { kind: "banner_not_found" }
      : { kind: "not_admin" };
  }
  if (status === 409) {
    if (problem?.type === "/problems/banner-version-conflict") {
      return { kind: "version_conflict", detail: problem.detail };
    }
    if (problem?.type === "/problems/banner-reorder-mismatch") {
      return { kind: "reorder_mismatch", detail: problem.detail };
    }
    return { kind: "unknown", status, detail: problem?.detail };
  }
  if (status === 400) {
    return {
      kind: "validation",
      fields: problem?.errors ?? [],
      detail: problem?.detail,
    };
  }
  return { kind: "unknown", status, detail: problem?.detail };
}

async function map<T>(res: Response): Promise<AdminBannersResult<T>> {
  if (res.ok) {
    return { ok: true, value: (await res.json()) as T };
  }
  return { ok: false, error: classifyError(res.status, await readProblem(res)) };
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    credentials: "include",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

// ─── Public surface ──────────────────────────────────────────────────────────

export async function fetchAdminBanners(): Promise<
  AdminBannersResult<AdminBannerList>
> {
  try {
    return await map<AdminBannerList>(
      await fetch(`${baseUrl}/admin/banners`, {
        credentials: "include",
        headers: { Accept: "application/json" },
        cache: "no-store",
      }),
    );
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}

export async function createBanner(
  input: BannerCreateInput,
): Promise<AdminBannersResult<AdminBannerSlide>> {
  try {
    return await map<AdminBannerSlide>(
      await fetch(`${baseUrl}/admin/banners`, jsonInit("POST", input)),
    );
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}

export async function updateBanner(
  id: string,
  input: BannerUpdateInput,
): Promise<AdminBannersResult<AdminBannerSlide>> {
  try {
    return await map<AdminBannerSlide>(
      await fetch(
        `${baseUrl}/admin/banners/${encodeURIComponent(id)}`,
        jsonInit("PATCH", input),
      ),
    );
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}

export async function reorderBanners(
  input: BannerReorderInput,
): Promise<AdminBannersResult<AdminBannerList>> {
  try {
    return await map<AdminBannerList>(
      await fetch(`${baseUrl}/admin/banners/reorder`, jsonInit("POST", input)),
    );
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}

export async function deleteBanner(
  id: string,
  expectedUpdatedAt: string,
): Promise<AdminBannersResult<BannerDeleteResult>> {
  try {
    return await map<BannerDeleteResult>(
      await fetch(
        `${baseUrl}/admin/banners/${encodeURIComponent(id)}`,
        jsonInit("DELETE", { expectedUpdatedAt }),
      ),
    );
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}
