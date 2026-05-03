/**
 * Browser-side auth helpers.
 *
 * Every call here:
 *   1. Hits the API at NEXT_PUBLIC_SHOP_API_URL (cross-origin in production —
 *      api.shop.example.com from shop.example.com — but same-site, so the
 *      session cookie rides along under SameSite=Lax).
 *   2. Sends `credentials: "include"`. Without this the browser refuses to
 *      send / accept the session cookie on cross-origin requests, even with
 *      Access-Control-Allow-Credentials: true on the API. Both sides have to
 *      opt in.
 *   3. Maps RFC 9457 `application/problem+json` errors into a typed
 *      AuthError discriminated union the UI can render with full type-safety.
 *
 * NOT used from Server Components — they call serverAuthFetch (./server.ts)
 * which forwards the incoming request's cookie via next/headers instead.
 */
import type {
  AuthError,
  AuthResult,
  AuthUser,
  LoginInput,
  RegisterInput,
} from "./types";

const baseUrl =
  process.env.NEXT_PUBLIC_SHOP_API_URL?.replace(/\/+$/, "") ??
  "http://localhost:3001";

/**
 * Shape of an RFC 9457 Problem we get back from the API. We deliberately
 * don't import the Zod schema here — keeps the browser bundle Zod-free.
 */
interface ProblemResponse {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  errors?: { path: string; message: string }[];
  unlockAt?: string;
}

async function authFetch(
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

/** Map an HTTP error response into our discriminated AuthError. */
function classifyError(status: number, problem?: ProblemResponse): AuthError {
  if (status === 400) {
    return {
      kind: "validation",
      fields: problem?.errors ?? [],
      detail: problem?.detail,
    };
  }
  if (status === 401) {
    // The /auth/me 401 is "no session" — distinct from /auth/login 401 which
    // is "wrong credentials". Both share status, but the route the UI hit
    // tells us which copy to render. Since the UI knows what it called, we
    // hand back `invalid_credentials` here and let the caller swap it for
    // `unauthenticated` if they were calling /me.
    return { kind: "invalid_credentials", detail: problem?.detail };
  }
  if (status === 429 && problem?.type === "/problems/account-locked") {
    return {
      kind: "account_locked",
      detail: problem.detail,
      unlockAt: problem.unlockAt,
    };
  }
  return { kind: "unknown", status, detail: problem?.detail };
}

async function withErrorMapping<T>(
  res: Response,
  parseSuccess: (r: Response) => Promise<T>,
): Promise<AuthResult<T>> {
  if (res.ok) {
    return { ok: true, value: await parseSuccess(res) };
  }
  const problem = await readProblem(res);
  return { ok: false, error: classifyError(res.status, problem) };
}

// ─── Public surface ────────────────────────────────────────────────────────

export async function login(input: LoginInput): Promise<AuthResult<AuthUser>> {
  let res: Response;
  try {
    res = await authFetch("/auth/login", {
      method: "POST",
      body: JSON.stringify(input),
    });
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
  return withErrorMapping(res, async (r) => {
    const body = (await r.json()) as { user: AuthUser };
    return body.user;
  });
}

/**
 * Register. Backend deliberately returns the same `{ ok: true }` shape
 * regardless of whether the email already existed — that's the
 * enumeration-resistant contract from the spec. The caller therefore can't
 * tell new vs duplicate from this function. When SES + verification land,
 * the duplicate branch will trigger a "you already have an account" email.
 */
export async function register(
  input: RegisterInput,
): Promise<AuthResult<{ ok: true }>> {
  let res: Response;
  try {
    res = await authFetch("/auth/register", {
      method: "POST",
      body: JSON.stringify(input),
    });
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
  return withErrorMapping(res, async (r) => {
    return (await r.json()) as { ok: true };
  });
}

/** Logout. Idempotent — 204 always (even with no cookie). */
export async function logout(): Promise<AuthResult<null>> {
  try {
    const res = await authFetch("/auth/logout", { method: "POST" });
    if (res.ok) return { ok: true, value: null };
    return {
      ok: false,
      error: { kind: "unknown", status: res.status, detail: "Logout failed" },
    };
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}

/**
 * Read the current user from the session cookie. Used by the AuthContext
 * on mount to bootstrap state.
 *
 * Re-classifies a 401 as `unauthenticated` rather than `invalid_credentials`
 * so the UI can show "you're signed out" instead of "wrong password".
 */
export async function fetchMe(): Promise<AuthResult<AuthUser>> {
  let res: Response;
  try {
    res = await authFetch("/auth/me");
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
  if (res.status === 401) {
    return { ok: false, error: { kind: "unauthenticated" } };
  }
  return withErrorMapping(res, async (r) => {
    const body = (await r.json()) as { user: AuthUser };
    return body.user;
  });
}
