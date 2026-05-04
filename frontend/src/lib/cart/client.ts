/**
 * Browser-side cart REST client.
 *
 * Mirrors the patterns in lib/auth/client.ts:
 *   1. Hits the API at NEXT_PUBLIC_SHOP_API_URL.
 *   2. Sends `credentials: "include"` so the session cookie rides cross-origin.
 *   3. Maps RFC 9457 problem+json into a typed CartError discriminated union.
 *
 * The cart endpoints all require auth (gated by requireAuth on the server).
 * If the cookie has expired between page load and a cart action, calls here
 * return `{ kind: "unauthenticated" }` and the UI should drop the user back
 * to /account/login (CartContext handles this transparently).
 */
import type {
  CartError,
  CartResult,
  CartView,
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

async function cartFetch(
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

function classifyError(status: number, problem?: ProblemResponse): CartError {
  if (status === 400) {
    return {
      kind: "validation",
      fields: problem?.errors ?? [],
      detail: problem?.detail,
    };
  }
  if (status === 401) {
    return { kind: "unauthenticated", detail: problem?.detail };
  }
  if (status === 404) {
    return { kind: "not_found", detail: problem?.detail };
  }
  if (status === 409 && problem?.type === "/problems/out-of-stock") {
    return { kind: "out_of_stock", detail: problem.detail };
  }
  return { kind: "unknown", status, detail: problem?.detail };
}

async function callJson<T>(
  promise: Promise<Response>,
): Promise<CartResult<T>> {
  let res: Response;
  try {
    res = await promise;
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
  if (!res.ok) {
    const problem = await readProblem(res);
    return { ok: false, error: classifyError(res.status, problem) };
  }
  try {
    const value = (await res.json()) as T;
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}

// ─── Public surface ────────────────────────────────────────────────────────

export async function fetchCart(): Promise<CartResult<CartView>> {
  return callJson<CartView>(cartFetch("/cart"));
}

export async function addCartItem(
  productId: string,
  quantity = 1,
): Promise<CartResult<CartView>> {
  return callJson<CartView>(
    cartFetch("/cart/items", {
      method: "POST",
      body: JSON.stringify({ productId, quantity }),
    }),
  );
}

export async function setCartItemQuantity(
  productId: string,
  quantity: number,
): Promise<CartResult<CartView>> {
  return callJson<CartView>(
    cartFetch(`/cart/items/${encodeURIComponent(productId)}`, {
      method: "PATCH",
      body: JSON.stringify({ quantity }),
    }),
  );
}

export async function removeCartItem(
  productId: string,
): Promise<CartResult<CartView>> {
  return callJson<CartView>(
    cartFetch(`/cart/items/${encodeURIComponent(productId)}`, {
      method: "DELETE",
    }),
  );
}

export async function clearCart(): Promise<CartResult<CartView>> {
  return callJson<CartView>(
    cartFetch("/cart", { method: "DELETE" }),
  );
}

export async function mergeCart(
  items: { productId: string; quantity: number }[],
): Promise<CartResult<CartView>> {
  return callJson<CartView>(
    cartFetch("/cart/merge", {
      method: "POST",
      body: JSON.stringify({ items }),
    }),
  );
}
