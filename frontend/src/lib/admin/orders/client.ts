/**
 * Browser-side client for the admin order-management API
 * (`/admin/orders/*` on shop-api — see backend routes/admin/orders.ts).
 *
 * Same transport posture as lib/admin/client.ts (the auth client): plain
 * `fetch` against NEXT_PUBLIC_SHOP_API_URL with `credentials: "include"` so
 * the admin session cookie rides along, and RFC 9457 problem responses
 * mapped into the typed `AdminOrdersError` union.
 */
import type {
  AdminOrderDetail,
  AdminOrdersError,
  AdminOrdersFilters,
  AdminOrdersPage,
  AdminOrdersResult,
  AdminOrderTransitionInput,
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
): AdminOrdersError {
  if (status === 404) {
    return problem?.type === "/problems/order-not-found"
      ? { kind: "order_not_found" }
      : { kind: "not_admin" };
  }
  if (status === 409) {
    if (problem?.type === "/problems/order-version-conflict") {
      return { kind: "version_conflict", detail: problem.detail };
    }
    return { kind: "invalid_transition", detail: problem?.detail };
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

async function map<T>(res: Response): Promise<AdminOrdersResult<T>> {
  if (res.ok) {
    return { ok: true, value: (await res.json()) as T };
  }
  return { ok: false, error: classifyError(res.status, await readProblem(res)) };
}

/** Serialise the filters into a query string (skips empty values). */
export function buildOrdersQuery(filters: AdminOrdersFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

export async function fetchAdminOrders(
  filters: AdminOrdersFilters = {},
): Promise<AdminOrdersResult<AdminOrdersPage>> {
  try {
    return await map<AdminOrdersPage>(
      await fetch(`${baseUrl}/admin/orders${buildOrdersQuery(filters)}`, {
        credentials: "include",
        headers: { Accept: "application/json" },
        cache: "no-store",
      }),
    );
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}

export async function fetchAdminOrder(
  orderNumber: string,
): Promise<AdminOrdersResult<AdminOrderDetail>> {
  try {
    return await map<AdminOrderDetail>(
      await fetch(`${baseUrl}/admin/orders/${encodeURIComponent(orderNumber)}`, {
        credentials: "include",
        headers: { Accept: "application/json" },
        cache: "no-store",
      }),
    );
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}

/** One state-machine hop. On 409 the caller should refetch and re-render. */
export async function transitionAdminOrder(
  orderNumber: string,
  input: AdminOrderTransitionInput,
): Promise<AdminOrdersResult<AdminOrderDetail>> {
  try {
    return await map<AdminOrderDetail>(
      await fetch(
        `${baseUrl}/admin/orders/${encodeURIComponent(orderNumber)}/status`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(input),
        },
      ),
    );
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}

/**
 * Download the CSV export for the CURRENT filters as a browser download.
 * Fetch-as-blob (not a plain <a href>) so the cookie always rides along
 * via CORS credentials, independent of SameSite navigation nuances.
 */
export async function downloadAdminOrdersCsv(
  filters: AdminOrdersFilters,
): Promise<AdminOrdersResult<void>> {
  try {
    const { page, pageSize, ...rest } = filters;
    void page;
    void pageSize;
    const res = await fetch(
      `${baseUrl}/admin/orders/export.csv${buildOrdersQuery(rest)}`,
      { credentials: "include" },
    );
    if (!res.ok) {
      return {
        ok: false,
        error: classifyError(res.status, await readProblem(res)),
      };
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    // Mirror the server's Content-Disposition filename when present.
    const disposition = res.headers.get("content-disposition") ?? "";
    const match = disposition.match(/filename="([^"]{1,100})"/);
    a.download = match?.[1] ?? "orders-export.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return { ok: true, value: undefined };
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}
