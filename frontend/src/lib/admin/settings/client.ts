/**
 * Browser-side client for the admin store-settings API (`/admin/settings` on
 * shop-api — see backend routes/admin/settings.ts).
 *
 * Same transport posture as lib/admin/banners|categories|products/client.ts:
 * plain `fetch` against NEXT_PUBLIC_SHOP_API_URL with `credentials: "include"`
 * so the admin session cookie rides along, and RFC 9457 `application/problem+json`
 * responses mapped into the typed `AdminSettingsError` union. The wire DTO comes
 * from `@shop/api` (re-exported through ./types).
 */
import type {
  AdminSettings,
  AdminSettingsError,
  AdminSettingsResult,
  SettingsUpdateInput,
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
): AdminSettingsError {
  if (status === 404) {
    // The whole admin surface collapses to 404 for non-admins; there is no
    // settings-specific 404, so any 404 here means "session gone".
    return { kind: "not_admin" };
  }
  if (status === 409) {
    return { kind: "version_conflict", detail: problem?.detail };
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

async function map<T>(res: Response): Promise<AdminSettingsResult<T>> {
  if (res.ok) {
    return { ok: true, value: (await res.json()) as T };
  }
  return { ok: false, error: classifyError(res.status, await readProblem(res)) };
}

export async function fetchAdminSettings(): Promise<
  AdminSettingsResult<AdminSettings>
> {
  try {
    return await map<AdminSettings>(
      await fetch(`${baseUrl}/admin/settings`, {
        credentials: "include",
        headers: { Accept: "application/json" },
        cache: "no-store",
      }),
    );
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}

export async function updateAdminSettings(
  input: SettingsUpdateInput,
): Promise<AdminSettingsResult<AdminSettings>> {
  try {
    return await map<AdminSettings>(
      await fetch(`${baseUrl}/admin/settings`, {
        method: "PATCH",
        credentials: "include",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      }),
    );
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}
