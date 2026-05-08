/**
 * Browser-side order REST client.
 *
 * Mirrors the patterns in lib/auth/client.ts and lib/cart/client.ts:
 *   1. Hits the API at NEXT_PUBLIC_SHOP_API_URL.
 *   2. Sends `credentials: "include"` so the session cookie rides cross-origin.
 *   3. Maps RFC 9457 problem+json into a typed OrderError discriminated union.
 *
 * All three endpoints require auth — the order routes are gated by
 * requireAuth on the backend, and the cart-merge / login flow is the only
 * legal path to having an authenticated cart at all. If the cookie has
 * expired between page load and submit, calls here surface as
 * `{ kind: "unauthenticated" }` and the UI bounces to /account/login.
 *
 * Idempotency-Key handling
 * ────────────────────────
 * Per the IETF httpapi-idempotency-key draft and Stripe / Adyen / MDN
 * guidance, the *client* generates a v4 UUID and sends it in the
 * `Idempotency-Key` request header. We intentionally make the parameter
 * REQUIRED — callers can't accidentally skip retry-safety. The same key
 * MUST be reused on automatic retries of the same logical operation; a
 * fresh key is appropriate when the user demonstrably composes a new
 * intent (e.g. fixes a validation error and re-submits is debatable but
 * fine either way — the server-side replay only fires if a prior order
 * was actually persisted).
 *
 * `crypto.randomUUID()` (browser-native since 2022, Node ≥ 19) is the
 * recommended generator. We don't ship one ourselves — exposing a
 * convenience wrapper here would invite "use a tiny helper that returns
 * Math.random hex" footguns.
 */
import type {
  OrderDTO,
  OrderError,
  OrderResult,
  PlaceOrderInput,
} from "./types";

const baseUrl =
  process.env.NEXT_PUBLIC_SHOP_API_URL?.replace(/\/+$/, "") ??
  "http://localhost:3001";

/** Wire shape of an RFC 9457 Problem we get back from the API. */
interface ProblemResponse {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  errors?: { path: string; message: string }[];
}

async function ordersFetch(
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

async function readProblem(
  res: Response,
): Promise<ProblemResponse | undefined> {
  try {
    return (await res.json()) as ProblemResponse;
  } catch {
    return undefined;
  }
}

function classifyError(
  status: number,
  problem?: ProblemResponse,
): OrderError {
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
  if (
    status === 403 &&
    problem?.type === "/problems/email-not-verified"
  ) {
    return { kind: "email_not_verified", detail: problem.detail };
  }
  if (status === 404) {
    return { kind: "not_found", detail: problem?.detail };
  }
  if (status === 409 && problem?.type === "/problems/out-of-stock") {
    return {
      kind: "out_of_stock",
      detail: problem.detail,
      offendingCodes: (problem.errors ?? []).map((e) => e.path),
    };
  }
  if (
    status === 409 &&
    problem?.type === "/problems/idempotency-conflict"
  ) {
    return { kind: "idempotency_conflict", detail: problem.detail };
  }
  if (status === 422 && problem?.type === "/problems/cart-empty") {
    return { kind: "cart_empty", detail: problem.detail };
  }
  if (status === 422 && problem?.type === "/problems/profile-required") {
    return { kind: "profile_required", detail: problem.detail };
  }
  return { kind: "unknown", status, detail: problem?.detail };
}

async function callJson<T>(
  promise: Promise<Response>,
): Promise<OrderResult<T>> {
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

/**
 * Place an order from the current authenticated cart.
 *
 * `idempotencyKey` MUST be a UUID-shaped string (the backend enforces
 * `min(8).max(255)` only, but UUIDs match the convention everywhere else
 * — Stripe, MDN, IETF draft). Generate ONCE per logical attempt with
 * `crypto.randomUUID()` and reuse on automatic retries.
 *
 * Behaviour:
 *   - 201 on first success → returns the placed order.
 *   - 201 on replay (same customer + same key) → returns the original
 *     order, cart untouched. The caller cannot tell first vs replay
 *     from the response, by design — both are "you already have this
 *     order, here it is".
 */
export async function placeOrder(
  input: PlaceOrderInput,
  idempotencyKey: string,
): Promise<OrderResult<OrderDTO>> {
  return callJson<OrderDTO>(
    ordersFetch("/orders", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(input),
    }),
  );
}

/**
 * List the current user's orders, newest first. Capped at 50 by the
 * backend (orders.ts: `.limit(50)`). Pagination beyond that is a future
 * slice — the spec only requires "recent orders".
 */
export async function fetchOrders(): Promise<OrderResult<OrderDTO[]>> {
  let res: Response;
  try {
    res = await ordersFetch("/orders");
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
  if (!res.ok) {
    const problem = await readProblem(res);
    return { ok: false, error: classifyError(res.status, problem) };
  }
  try {
    const body = (await res.json()) as { items: OrderDTO[] };
    return { ok: true, value: body.items };
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}

/**
 * Fetch one order by its public orderNumber (e.g. "2026-05-00123").
 *
 * 404 from the backend is enumeration-safe: it's returned both for
 * non-existent numbers AND for orders that belong to a different user.
 * UI-side we map both to "Поръчката не е намерена."
 */
export async function fetchOrder(
  orderNumber: string,
): Promise<OrderResult<OrderDTO>> {
  return callJson<OrderDTO>(
    ordersFetch(`/orders/${encodeURIComponent(orderNumber)}`),
  );
}
