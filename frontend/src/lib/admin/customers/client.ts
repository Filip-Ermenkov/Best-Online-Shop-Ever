/**
 * Browser-side client for the admin account-management API (`/admin/customers`
 * on shop-api — see backend routes/admin/customers.ts).
 *
 * Same transport posture as lib/admin/{orders,banners,settings}/client.ts: plain
 * `fetch` against NEXT_PUBLIC_SHOP_API_URL with `credentials: "include"` so the
 * admin session cookie rides along, and RFC 9457 `application/problem+json`
 * responses mapped into the typed `AdminCustomersError` union.
 */
import type {
  AdminCustomerDetail,
  AdminCustomerDiscount,
  AdminCustomerList,
  AdminCustomersResult,
  CustomerListFilters,
  SetDiscountInput,
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

function classifyError(status: number, problem?: ProblemResponse) {
  if (status === 404) {
    // The admin surface collapses to a flat 404 for non-admins; a genuine
    // "no such customer" carries the specific problem type.
    return problem?.type === "/problems/customer-not-found"
      ? ({ kind: "not_found" } as const)
      : ({ kind: "not_admin" } as const);
  }
  if (status === 409) {
    return { kind: "version_conflict", detail: problem?.detail } as const;
  }
  if (status === 422) {
    return {
      kind: "active_orders",
      orderNumbers: (problem?.errors ?? []).map((e) => e.path),
      detail: problem?.detail,
    } as const;
  }
  if (status === 400) {
    return {
      kind: "validation",
      fields: problem?.errors ?? [],
      detail: problem?.detail,
    } as const;
  }
  return { kind: "unknown", status, detail: problem?.detail } as const;
}

async function map<T>(res: Response): Promise<AdminCustomersResult<T>> {
  if (res.ok) {
    return { ok: true, value: (await res.json()) as T };
  }
  return { ok: false, error: classifyError(res.status, await readProblem(res)) };
}

function qs(filters: CustomerListFilters): string {
  const p = new URLSearchParams();
  if (filters.q) p.set("q", filters.q);
  if (filters.accountType) p.set("accountType", filters.accountType);
  if (filters.hasDiscount) p.set("hasDiscount", filters.hasDiscount);
  if (filters.page && filters.page > 1) p.set("page", String(filters.page));
  const s = p.toString();
  return s ? `?${s}` : "";
}

export async function fetchAdminCustomers(
  filters: CustomerListFilters = {},
): Promise<AdminCustomersResult<AdminCustomerList>> {
  try {
    return await map<AdminCustomerList>(
      await fetch(`${baseUrl}/admin/customers${qs(filters)}`, {
        credentials: "include",
        headers: { Accept: "application/json" },
        cache: "no-store",
      }),
    );
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}

export async function fetchAdminCustomer(
  id: string,
): Promise<AdminCustomersResult<AdminCustomerDetail>> {
  try {
    return await map<AdminCustomerDetail>(
      await fetch(`${baseUrl}/admin/customers/${encodeURIComponent(id)}`, {
        credentials: "include",
        headers: { Accept: "application/json" },
        cache: "no-store",
      }),
    );
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}

export async function setCustomerDiscount(
  id: string,
  input: SetDiscountInput,
): Promise<AdminCustomersResult<AdminCustomerDiscount>> {
  try {
    return await map<AdminCustomerDiscount>(
      await fetch(`${baseUrl}/admin/customers/${encodeURIComponent(id)}/discount`, {
        method: "PUT",
        credentials: "include",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}

export async function clearCustomerDiscount(
  id: string,
): Promise<AdminCustomersResult<{ cleared: boolean }>> {
  try {
    return await map<{ cleared: boolean }>(
      await fetch(`${baseUrl}/admin/customers/${encodeURIComponent(id)}/discount`, {
        method: "DELETE",
        credentials: "include",
        headers: { Accept: "application/json" },
      }),
    );
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}

export async function deleteAdminCustomer(
  id: string,
): Promise<AdminCustomersResult<{ deleted: boolean }>> {
  try {
    return await map<{ deleted: boolean }>(
      await fetch(`${baseUrl}/admin/customers/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "include",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ confirmConsequences: true }),
      }),
    );
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}
