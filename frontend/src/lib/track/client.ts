/**
 * Browser-side client for the public guest surface (the spec's "Гост" role).
 *
 * Mirrors lib/orders/client.ts, with two deliberate differences:
 *   - These endpoints are anonymous, so we do NOT send `credentials: include`
 *     (no session cookie is relevant; the tracking token is the only
 *     credential). Cross-origin requests therefore carry no cookies.
 *   - Maps the guest/track problem+json into typed unions (see ./types).
 */
import type {
  GuestOrder,
  GuestOrderError,
  GuestOrderResult,
  GuestPlaceOrderInput,
  TrackedOrder,
  TrackError,
  TrackResult,
  TrackWithdrawalEligibility,
  TrackWithdrawalRecord,
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

async function trackFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
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

// ─── Guest order placement ───────────────────────────────────────────────────

function classifyGuestOrderError(status: number, p?: ProblemResponse): GuestOrderError {
  if (status === 400) {
    return { kind: "validation", fields: p?.errors ?? [], detail: p?.detail };
  }
  if (status === 409 && p?.type === "/problems/out-of-stock") {
    return {
      kind: "out_of_stock",
      detail: p.detail,
      offendingIds: (p.errors ?? []).map((e) => e.path),
    };
  }
  if (status === 409 && p?.type === "/problems/idempotency-conflict") {
    return { kind: "idempotency_conflict", detail: p.detail };
  }
  if (status === 422) {
    return { kind: "cart_empty", detail: p?.detail };
  }
  if (status === 429) {
    return { kind: "rate_limited", detail: p?.detail };
  }
  return { kind: "unknown", status, detail: p?.detail };
}

export async function placeGuestOrder(
  input: GuestPlaceOrderInput,
  idempotencyKey: string,
): Promise<GuestOrderResult<GuestOrder>> {
  let res: Response;
  try {
    res = await trackFetch("/guest/orders", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(input),
    });
  } catch (cause) {
    return { ok: false, error: { kind: "network", cause } };
  }
  if (!res.ok) {
    return { ok: false, error: classifyGuestOrderError(res.status, await readProblem(res)) };
  }
  try {
    return { ok: true, value: (await res.json()) as GuestOrder };
  } catch (cause) {
    return { ok: false, error: { kind: "network", cause } };
  }
}

// ─── Track surface ───────────────────────────────────────────────────────────

function classifyTrackError(status: number, p?: ProblemResponse): TrackError {
  if (status === 404) return { kind: "not_found", detail: p?.detail };
  if (status === 422 && p?.type === "/problems/order-not-cancellable") {
    return { kind: "not_cancellable", detail: p.detail };
  }
  if (status === 422 && p?.type === "/problems/withdrawal-window-expired") {
    return { kind: "withdrawal_window_expired", detail: p.detail };
  }
  if (status === 422 && p?.type === "/problems/withdrawal-not-accepted") {
    return { kind: "withdrawal_not_accepted", detail: p.detail };
  }
  if (status === 429) return { kind: "rate_limited", detail: p?.detail };
  return { kind: "unknown", status, detail: p?.detail };
}

async function callTrackJson<T>(promise: Promise<Response>): Promise<TrackResult<T>> {
  let res: Response;
  try {
    res = await promise;
  } catch (cause) {
    return { ok: false, error: { kind: "network", cause } };
  }
  if (!res.ok) {
    return { ok: false, error: classifyTrackError(res.status, await readProblem(res)) };
  }
  try {
    return { ok: true, value: (await res.json()) as T };
  } catch (cause) {
    return { ok: false, error: { kind: "network", cause } };
  }
}

export async function fetchTrackedOrder(token: string): Promise<TrackResult<TrackedOrder>> {
  return callTrackJson<TrackedOrder>(trackFetch(`/track/${encodeURIComponent(token)}`));
}

export async function cancelTrackedOrder(token: string): Promise<TrackResult<TrackedOrder>> {
  return callTrackJson<TrackedOrder>(
    trackFetch(`/track/${encodeURIComponent(token)}/cancel`, { method: "POST" }),
  );
}

export async function fetchTrackWithdrawalEligibility(
  token: string,
): Promise<TrackResult<TrackWithdrawalEligibility>> {
  return callTrackJson<TrackWithdrawalEligibility>(
    trackFetch(`/track/${encodeURIComponent(token)}/withdrawal/eligibility`),
  );
}

export async function submitTrackWithdrawal(
  token: string,
  reason?: string,
): Promise<TrackResult<TrackWithdrawalRecord>> {
  return callTrackJson<TrackWithdrawalRecord>(
    trackFetch(`/track/${encodeURIComponent(token)}/withdrawal`, {
      method: "POST",
      body: JSON.stringify(reason && reason.trim().length > 0 ? { reason: reason.trim() } : {}),
    }),
  );
}

/**
 * Find-my-order resend. The endpoint is enumeration-resistant — it returns
 * `{ ok: true }` whether or not the order/email matched — so the UI always
 * shows the same neutral confirmation. The only distinguishable outcome is the
 * 3/hour/IP rate limit (429).
 */
export async function findMyOrder(
  orderNumber: string,
  email: string,
): Promise<TrackResult<{ ok: true }>> {
  return callTrackJson<{ ok: true }>(
    trackFetch("/track/find", {
      method: "POST",
      body: JSON.stringify({ orderNumber: orderNumber.trim(), email: email.trim() }),
    }),
  );
}
