/**
 * Browser-side client for the admin category-management API
 * (`/admin/categories/*` on shop-api — see backend routes/admin/categories.ts).
 *
 * Same transport posture as lib/admin/orders/client.ts: plain `fetch` against
 * NEXT_PUBLIC_SHOP_API_URL with `credentials: "include"` so the admin session
 * cookie rides along, and RFC 9457 problem responses mapped into the typed
 * `AdminCategoriesError` union.
 */
import type {
  AdminCategoryDeletionImpact,
  AdminCategoryNode,
  AdminCategoryTree,
  AdminCategoriesError,
  AdminCategoriesResult,
  CategoryCreateInput,
  CategoryReorderInput,
  CategoryUpdateInput,
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
): AdminCategoriesError {
  if (status === 404) {
    return problem?.type === "/problems/category-not-found"
      ? { kind: "category_not_found" }
      : { kind: "not_admin" };
  }
  if (status === 409) {
    if (problem?.type === "/problems/category-slug-conflict") {
      return { kind: "slug_conflict", detail: problem.detail };
    }
    if (problem?.type === "/problems/category-version-conflict") {
      return { kind: "version_conflict", detail: problem.detail };
    }
    if (problem?.type === "/problems/category-reorder-mismatch") {
      return { kind: "reorder_mismatch", detail: problem.detail };
    }
    return { kind: "unknown", status, detail: problem?.detail };
  }
  if (status === 422 && problem?.type === "/problems/category-move-cycle") {
    return { kind: "move_cycle", detail: problem.detail };
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

async function map<T>(res: Response): Promise<AdminCategoriesResult<T>> {
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

export async function fetchAdminCategoryTree(): Promise<
  AdminCategoriesResult<AdminCategoryTree>
> {
  try {
    return await map<AdminCategoryTree>(
      await fetch(`${baseUrl}/admin/categories`, {
        credentials: "include",
        headers: { Accept: "application/json" },
        cache: "no-store",
      }),
    );
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}

export async function createCategory(
  input: CategoryCreateInput,
): Promise<AdminCategoriesResult<AdminCategoryNode>> {
  try {
    return await map<AdminCategoryNode>(
      await fetch(`${baseUrl}/admin/categories`, jsonInit("POST", input)),
    );
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}

export async function updateCategory(
  id: string,
  input: CategoryUpdateInput,
): Promise<AdminCategoriesResult<AdminCategoryNode>> {
  try {
    return await map<AdminCategoryNode>(
      await fetch(
        `${baseUrl}/admin/categories/${encodeURIComponent(id)}`,
        jsonInit("PATCH", input),
      ),
    );
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}

export async function reorderCategories(
  input: CategoryReorderInput,
): Promise<AdminCategoriesResult<AdminCategoryTree>> {
  try {
    return await map<AdminCategoryTree>(
      await fetch(`${baseUrl}/admin/categories/reorder`, jsonInit("POST", input)),
    );
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}

export async function fetchDeletionImpact(
  id: string,
): Promise<AdminCategoriesResult<AdminCategoryDeletionImpact>> {
  try {
    return await map<AdminCategoryDeletionImpact>(
      await fetch(
        `${baseUrl}/admin/categories/${encodeURIComponent(id)}/deletion-impact`,
        { credentials: "include", headers: { Accept: "application/json" }, cache: "no-store" },
      ),
    );
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}

export async function deleteCategory(
  id: string,
  expectedUpdatedAt: string,
): Promise<
  AdminCategoriesResult<{
    deletedCategories: number;
    deletedProducts: number;
    redirectsWritten: number;
  }>
> {
  try {
    return await map(
      await fetch(
        `${baseUrl}/admin/categories/${encodeURIComponent(id)}`,
        jsonInit("DELETE", { expectedUpdatedAt, confirmConsequences: true }),
      ),
    );
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}
