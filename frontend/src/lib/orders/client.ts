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
  SubmitWithdrawalInput,
  WithdrawalEligibility,
  WithdrawalError,
  WithdrawalRecord,
  WithdrawalResult,
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

// ─── Withdrawal client ────────────────────────────────────────────────────
//
// Three endpoints powering the 14-day right of withdrawal (EU Directive
// 2023/2673 Art. 11a — mandatory 19 June 2026):
//
//   - GET  /orders/:n/withdrawal/eligibility  → render-or-hide the button
//   - GET  /orders/:n/withdrawal              → re-fetch a prior submission
//                                               for the "already done" UI
//   - POST /orders/:n/withdrawal              → submit; ack screen renders
//                                               server-side timestamp
//
// All three are auth-gated. The withdrawal endpoints have their own typed
// error union (WithdrawalError) because two of the failure modes —
// `withdrawal_window_expired` and `withdrawal_not_accepted` — only apply
// here. The remaining variants (network / unauthenticated / not_found /
// validation / unknown) are the same shape as OrderError.

function classifyWithdrawalError(
  status: number,
  problem?: ProblemResponse,
): WithdrawalError {
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
  if (
    status === 422 &&
    problem?.type === "/problems/withdrawal-window-expired"
  ) {
    return { kind: "withdrawal_window_expired", detail: problem.detail };
  }
  if (
    status === 422 &&
    problem?.type === "/problems/withdrawal-not-accepted"
  ) {
    return { kind: "withdrawal_not_accepted", detail: problem.detail };
  }
  return { kind: "unknown", status, detail: problem?.detail };
}

async function callWithdrawalJson<T>(
  promise: Promise<Response>,
): Promise<WithdrawalResult<T>> {
  let res: Response;
  try {
    res = await promise;
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
  if (!res.ok) {
    const problem = await readProblem(res);
    return { ok: false, error: classifyWithdrawalError(res.status, problem) };
  }
  try {
    const value = (await res.json()) as T;
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}

/**
 * GET /orders/:n/withdrawal/eligibility — drives the conditional rendering
 * of the withdrawal button on the order detail page.
 *
 * The backend returns 200 for both eligible and ineligible-but-existing
 * orders. 404 is reserved for orders that don't exist or belong to
 * someone else (the existing enumeration-resistant contract).
 */
export async function fetchWithdrawalEligibility(
  orderNumber: string,
): Promise<WithdrawalResult<WithdrawalEligibility>> {
  return callWithdrawalJson<WithdrawalEligibility>(
    ordersFetch(
      `/orders/${encodeURIComponent(orderNumber)}/withdrawal/eligibility`,
    ),
  );
}

/**
 * GET /orders/:n/withdrawal — fetch a previously-submitted withdrawal
 * record so the user can re-read their durable-medium receipt.
 *
 * 404 is the conventional "no record exists" response. The withdrawal
 * page handler treats it as "no submission yet, show the form".
 */
export async function fetchWithdrawal(
  orderNumber: string,
): Promise<WithdrawalResult<WithdrawalRecord>> {
  return callWithdrawalJson<WithdrawalRecord>(
    ordersFetch(`/orders/${encodeURIComponent(orderNumber)}/withdrawal`),
  );
}

/**
 * POST /orders/:n/withdrawal — submit the consumer's withdrawal.
 *
 * The endpoint is idempotent at the DB level — a second submission for
 * the same order returns 200 with the original record. The FE doesn't
 * need to distinguish 201 from 200; both mean "you have a valid
 * submission, here it is". The UI uses the returned `submittedAt` /
 * `acknowledgedAt` to render the durable-medium receipt.
 */
export async function submitWithdrawal(
  orderNumber: string,
  input: SubmitWithdrawalInput = {},
): Promise<WithdrawalResult<WithdrawalRecord>> {
  return callWithdrawalJson<WithdrawalRecord>(
    ordersFetch(
      `/orders/${encodeURIComponent(orderNumber)}/withdrawal`,
      {
        method: "POST",
        body: JSON.stringify(
          input.reason && input.reason.trim().length > 0
            ? { reason: input.reason.trim() }
            : {},
        ),
      },
    ),
  );
}
