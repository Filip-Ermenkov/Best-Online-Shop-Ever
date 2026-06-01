/**
 * Browser-side address-book client.
 *
 * Same transport posture as lib/auth/client.ts: every call hits
 * NEXT_PUBLIC_SHOP_API_URL with `credentials: "include"` so the session
 * cookie rides along, and RFC 9457 `application/problem+json` errors are
 * mapped into a typed `AddressError` discriminated union the page renders
 * with full type-safety.
 *
 * Plain `fetch` (no Hono RPC client) with the concrete `Address` DTO from
 * `@shop/api` for the success shapes — consistent with lib/api.ts.
 */
import type {
  Address,
  AddressError,
  AddressResult,
  CreateAddressInput,
  UpdateAddressInput,
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

async function addressFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
}

async function readProblem(res: Response): Promise<ProblemResponse | undefined> {
  try {
    return (await res.json()) as ProblemResponse;
  } catch {
    return undefined;
  }
}

/** Map an HTTP error response into the discriminated AddressError. */
function classifyError(status: number, problem?: ProblemResponse): AddressError {
  if (status === 400) {
    return {
      kind: "validation",
      fields: problem?.errors ?? [],
      detail: problem?.detail,
    };
  }
  if (status === 401) {
    return { kind: "unauthenticated" };
  }
  if (status === 404) {
    return { kind: "not_found", detail: problem?.detail };
  }
  if (status === 422 && problem?.type === "/problems/address-limit-reached") {
    return { kind: "limit_reached", detail: problem.detail };
  }
  return { kind: "unknown", status, detail: problem?.detail };
}

async function withErrorMapping<T>(
  res: Response,
  parseSuccess: (r: Response) => Promise<T>,
): Promise<AddressResult<T>> {
  if (res.ok) {
    return { ok: true, value: await parseSuccess(res) };
  }
  const problem = await readProblem(res);
  return { ok: false, error: classifyError(res.status, problem) };
}

// ─── Public surface ──────────────────────────────────────────────────────────

/** List the current user's saved addresses (soft-deleted ones excluded). */
export async function listAddresses(): Promise<AddressResult<Address[]>> {
  let res: Response;
  try {
    res = await addressFetch("/addresses");
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
  return withErrorMapping(res, async (r) => {
    const body = (await r.json()) as { items: Address[] };
    return body.items;
  });
}

/** Create a new address. Returns the created row. */
export async function createAddress(
  input: CreateAddressInput,
): Promise<AddressResult<Address>> {
  let res: Response;
  try {
    res = await addressFetch("/addresses", {
      method: "POST",
      body: JSON.stringify(input),
    });
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
  return withErrorMapping(res, async (r) => (await r.json()) as Address);
}

/** Partially update an address. Returns the updated row. */
export async function updateAddress(
  id: string,
  input: UpdateAddressInput,
): Promise<AddressResult<Address>> {
  let res: Response;
  try {
    res = await addressFetch(`/addresses/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
  return withErrorMapping(res, async (r) => (await r.json()) as Address);
}

/** Remove an address (soft delete on the server). Resolves to null on 204. */
export async function deleteAddress(id: string): Promise<AddressResult<null>> {
  let res: Response;
  try {
    res = await addressFetch(`/addresses/${id}`, { method: "DELETE" });
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
  if (res.status === 204) {
    return { ok: true, value: null };
  }
  const problem = await readProblem(res);
  return { ok: false, error: classifyError(res.status, problem) };
}
