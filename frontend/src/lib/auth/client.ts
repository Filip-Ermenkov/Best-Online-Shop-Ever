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
  if (status === 400 && problem?.type === "/problems/breached-password") {
    // Distinct kind so the register / reset-password pages can render a
    // localized "this password is in a breach corpus" message instead of
    // surfacing the server's English text. The per-field info is still
    // available for highlighting the correct input.
    return {
      kind: "breached_password",
      fields: problem.errors ?? [],
      detail: problem.detail,
    };
  }
  if (status === 400 && problem?.type === "/problems/same-password") {
    // Specific to /auth/change-password. Lets the profile page render a
    // localized "your new password must differ" inline against the
    // newPassword input without parsing English `detail`.
    return {
      kind: "same_password",
      fields: problem.errors ?? [],
      detail: problem.detail,
    };
  }
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
  if (status === 429 && problem?.type === "/problems/resend-rate-limited") {
    return { kind: "resend_rate_limited", detail: problem.detail };
  }
  if (status === 400 && problem?.type === "/problems/invalid-reset-token") {
    return { kind: "invalid_reset_token", detail: problem.detail };
  }
  if (
    status === 400 &&
    problem?.type === "/problems/invalid-email-change-token"
  ) {
    return { kind: "invalid_email_change_token", detail: problem.detail };
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
 * Confirm an email address. The token comes from the verification email
 * link's `?token=...` query parameter. The backend hashes it, looks up the
 * row, marks consumed, sets users.email_verified_at.
 *
 * No session cookie required — the link IS the proof of ownership. The user
 * may click it from any device, including one that has never logged in.
 */
export async function verifyEmail(
  token: string,
): Promise<AuthResult<{ ok: true }>> {
  let res: Response;
  try {
    res = await authFetch("/auth/verify-email", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
  return withErrorMapping(res, async (r) => {
    return (await r.json()) as { ok: true };
  });
}

/**
 * Trigger another verification email for the currently logged-in user.
 * Backend rate-limits at 3/hour, 5/day. Already-verified accounts return
 * the same 200 — UI consumers should refresh /auth/me afterwards if they
 * want to confirm status.
 */
export async function resendVerification(): Promise<AuthResult<{ ok: true }>> {
  let res: Response;
  try {
    res = await authFetch("/auth/resend-verification", { method: "POST" });
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
  return withErrorMapping(res, async (r) => {
    return (await r.json()) as { ok: true };
  });
}

/**
 * Request a password-reset email.
 *
 * The backend returns the same `{ ok: true }` regardless of whether the
 * email is registered (enumeration resistance). Callers should always show
 * the same "if the email exists, you'll receive a link" copy to the user.
 *
 * Validation errors (e.g. malformed email) still surface as 400 — render
 * them inline against the input.
 */
export async function forgotPassword(
  email: string,
): Promise<AuthResult<{ ok: true }>> {
  let res: Response;
  try {
    res = await authFetch("/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
  return withErrorMapping(res, async (r) => {
    return (await r.json()) as { ok: true };
  });
}

/**
 * Probe whether a reset token is still good, WITHOUT consuming it.
 *
 * The reset page fires this on mount so it can render the dead-link UI
 * immediately for a consumed/expired link instead of making the user type
 * a new password before learning the link is dead. Industry-standard UX
 * (GitHub, Google, Auth0).
 *
 * 400/invalid_reset_token = dead. 200 = live. Network errors bubble up as
 * `kind: "network"` and the caller should keep the form usable (fall back
 * to the post-submit failure path) rather than hide it — better to let
 * the user try than to lock them out on a transient blip.
 */
export async function validateResetToken(
  token: string,
): Promise<AuthResult<{ valid: true }>> {
  let res: Response;
  try {
    res = await authFetch("/auth/reset-password/check", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
  return withErrorMapping(res, async (r) => {
    return (await r.json()) as { valid: true };
  });
}

/**
 * Submit a new password using the token from the reset email.
 *
 * On success the backend has rotated the password AND dropped every session
 * for the user — including, in the unlikely case the user was logged in on
 * THIS device, this one. UI should redirect to /account/login afterwards.
 *
 * Errors:
 *   - kind === "invalid_reset_token": link is bad/expired/consumed. Show
 *     the generic "request a new link" copy.
 *   - kind === "validation": the new password failed strength rules. Render
 *     the field-level errors inline.
 */
export async function resetPassword(
  token: string,
  newPassword: string,
): Promise<AuthResult<{ ok: true }>> {
  let res: Response;
  try {
    res = await authFetch("/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token, newPassword }),
    });
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
  return withErrorMapping(res, async (r) => {
    return (await r.json()) as { ok: true };
  });
}

/**
 * Rotate the currently authenticated user's password.
 *
 * Requires the current password as re-auth proof — the backend will
 * constant-time-verify it against the stored Argon2id hash and increment
 * the shared-with-/login lockout counter on failure. On success, the
 * backend has:
 *   - rotated users.password_hash to a fresh Argon2id digest,
 *   - dropped every OTHER session for this user (phone, tablet, etc.),
 *   - kept THIS session alive — the caller stays logged in,
 *   - sent a best-effort "your password was changed" notification email.
 *
 * The session cookie does NOT change. No redirect is required; the UI
 * should simply clear the form and surface a success state.
 *
 * Failure branches:
 *   - kind === "invalid_credentials": currentPassword was wrong. Render
 *     inline against the currentPassword input. Note that repeated
 *     failures here trip the same lockout as /auth/login.
 *   - kind === "validation": newPassword failed the length check (<12
 *     chars). Render the field-level error inline against newPassword.
 *   - kind === "breached_password": newPassword appears in the HIBP
 *     breach corpus. Localized field-level copy.
 *   - kind === "same_password": newPassword === currentPassword. UX nudge
 *     rendered inline against newPassword.
 *   - kind === "account_locked": 5+ failed verifies in the rolling 15-min
 *     window. Same surface as the login-lockout case.
 *   - kind === "network": fetch failed.
 */
export async function changePassword(input: {
  currentPassword: string;
  newPassword: string;
}): Promise<AuthResult<{ ok: true }>> {
  let res: Response;
  try {
    res = await authFetch("/auth/change-password", {
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

/**
 * Request to change the current user's email address.
 *
 * Requires authentication AND the current password as re-auth proof. The
 * backend returns the same `{ ok: true }` regardless of whether the new
 * address is already in use OR an internal rate-limit was hit
 * (enumeration-resistance). The UI should always show the same "we sent a
 * verification link to your new address" copy on any 200.
 *
 * Failure branches:
 *   - kind === "invalid_credentials": current password was wrong. Render
 *     inline against the password input.
 *   - kind === "validation": malformed new email OR new email is the same
 *     as the current address (backend rejects that explicitly because the
 *     authenticated user can already see their own email).
 *   - kind === "network": fetch failed.
 */
export async function requestEmailChange(input: {
  currentPassword: string;
  newEmail: string;
}): Promise<AuthResult<{ ok: true }>> {
  let res: Response;
  try {
    res = await authFetch("/auth/email-change/request", {
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

/**
 * Probe whether an email-change verify token is still good, WITHOUT
 * consuming it. Symmetric to validateResetToken — same lifecycle, same
 * enumeration-resistance contract.
 *
 * On 200 the response carries the destination address so the verify page
 * can render "you are about to confirm change to X" copy. The destination
 * is the same email the recipient already received this link from, so the
 * disclosure is value-neutral.
 *
 * 400/invalid_email_change_token = dead. Network errors keep the form
 * usable (caller falls back to the post-submit failure path).
 */
export async function validateEmailChangeToken(
  token: string,
): Promise<AuthResult<{ valid: true; newEmail: string }>> {
  let res: Response;
  try {
    res = await authFetch("/auth/email-change/verify/check", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
  return withErrorMapping(res, async (r) => {
    return (await r.json()) as { valid: true; newEmail: string };
  });
}

/**
 * Confirm an email change. The token comes from the link in the verify
 * email. On success the backend has:
 *   - rotated users.email to the new address,
 *   - marked the new address verified (the click IS the proof),
 *   - dropped EVERY session for the user, including (if applicable) the
 *     one belonging to the device that's calling this function.
 *
 * The UI must redirect to /account/login afterwards. Like the password-reset
 * flow, we deliberately do NOT auto-login the user — re-authenticating with
 * the new email is the contract.
 *
 * Errors:
 *   - kind === "invalid_email_change_token": link is bad/expired/consumed
 *     OR the destination has been taken by someone else in the meantime.
 *     Show the generic "request a new link" copy.
 */
export async function confirmEmailChange(
  token: string,
): Promise<AuthResult<{ ok: true }>> {
  let res: Response;
  try {
    res = await authFetch("/auth/email-change/verify", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
  return withErrorMapping(res, async (r) => {
    return (await r.json()) as { ok: true };
  });
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
