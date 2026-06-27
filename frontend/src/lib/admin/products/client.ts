/**
 * Browser-side client for the admin product-management API
 * (`/admin/products/*` on shop-api — see backend routes/admin/products.ts),
 * roadmap item 22.
 *
 * Same transport posture as lib/admin/categories/client.ts: plain `fetch`
 * against NEXT_PUBLIC_SHOP_API_URL with `credentials: "include"` so the admin
 * session cookie rides along, and RFC 9457 `application/problem+json` responses
 * mapped into the typed `AdminProductsError` union. The wire DTOs come from
 * `@shop/api` (re-exported through ./types), so there is exactly one definition
 * of each shape, server-side.
 */
import type {
  AdminProductDetail,
  AdminProductList,
  AdminProductListQuery,
  AdminProductsResult,
  AdminProductsError,
  ProductCreateInput,
  ProductDeleteResult,
  ProductReorderInput,
  ProductReorderResult,
  ProductUpdateInput,
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
): AdminProductsError {
  if (status === 404) {
    return problem?.type === "/problems/product-not-found"
      ? { kind: "product_not_found" }
      : { kind: "not_admin" };
  }
  if (status === 409) {
    if (problem?.type === "/problems/product-slug-conflict") {
      return { kind: "slug_conflict", detail: problem.detail };
    }
    if (problem?.type === "/problems/product-code-conflict") {
      return { kind: "code_conflict", detail: problem.detail };
    }
    if (problem?.type === "/problems/product-version-conflict") {
      return { kind: "version_conflict", detail: problem.detail };
    }
    if (problem?.type === "/problems/product-reorder-mismatch") {
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

async function map<T>(res: Response): Promise<AdminProductsResult<T>> {
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

/** Serialise a list query into a querystring, omitting unset fields. */
function listQueryString(query: AdminProductListQuery): string {
  const params = new URLSearchParams();
  if (query.page != null) params.set("page", String(query.page));
  if (query.pageSize != null) params.set("pageSize", String(query.pageSize));
  if (query.status) params.set("status", query.status);
  if (query.categoryId) params.set("categoryId", query.categoryId);
  if (query.stockStatus) params.set("stockStatus", query.stockStatus);
  if (query.q && query.q.trim()) params.set("q", query.q.trim());
  if (query.sort) params.set("sort", query.sort);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

// ─── Public surface ──────────────────────────────────────────────────────────

export async function fetchAdminProducts(
  query: AdminProductListQuery = {},
): Promise<AdminProductsResult<AdminProductList>> {
  try {
    return await map<AdminProductList>(
      await fetch(`${baseUrl}/admin/products${listQueryString(query)}`, {
        credentials: "include",
        headers: { Accept: "application/json" },
        cache: "no-store",
      }),
    );
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}

export async function fetchAdminProduct(
  id: string,
): Promise<AdminProductsResult<AdminProductDetail>> {
  try {
    return await map<AdminProductDetail>(
      await fetch(`${baseUrl}/admin/products/${encodeURIComponent(id)}`, {
        credentials: "include",
        headers: { Accept: "application/json" },
        cache: "no-store",
      }),
    );
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}

export async function createProduct(
  input: ProductCreateInput,
): Promise<AdminProductsResult<AdminProductDetail>> {
  try {
    return await map<AdminProductDetail>(
      await fetch(`${baseUrl}/admin/products`, jsonInit("POST", input)),
    );
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}

export async function updateProduct(
  id: string,
  input: ProductUpdateInput,
): Promise<AdminProductsResult<AdminProductDetail>> {
  try {
    return await map<AdminProductDetail>(
      await fetch(
        `${baseUrl}/admin/products/${encodeURIComponent(id)}`,
        jsonInit("PATCH", input),
      ),
    );
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}

export async function reorderProducts(
  input: ProductReorderInput,
): Promise<AdminProductsResult<ProductReorderResult>> {
  try {
    return await map<ProductReorderResult>(
      await fetch(`${baseUrl}/admin/products/reorder`, jsonInit("POST", input)),
    );
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}

export async function deleteProduct(
  id: string,
  expectedUpdatedAt: string,
): Promise<AdminProductsResult<ProductDeleteResult>> {
  try {
    return await map<ProductDeleteResult>(
      await fetch(
        `${baseUrl}/admin/products/${encodeURIComponent(id)}`,
        jsonInit("DELETE", { expectedUpdatedAt, confirmConsequences: true }),
      ),
    );
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}

export async function restoreProduct(
  id: string,
): Promise<AdminProductsResult<AdminProductDetail>> {
  try {
    return await map<AdminProductDetail>(
      await fetch(
        `${baseUrl}/admin/products/${encodeURIComponent(id)}/restore`,
        { method: "POST", credentials: "include", headers: { Accept: "application/json" } },
      ),
    );
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}
