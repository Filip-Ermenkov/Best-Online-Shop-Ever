/**
 * Browser-side admin authentication client for /admin/auth/*.
 *
 * Same transport posture as lib/addresses/client.ts and lib/auth/client.ts:
 * plain `fetch` against NEXT_PUBLIC_SHOP_API_URL with `credentials: "include"`
 * so the session cookie the backend sets on the MFA/confirm step rides along,
 * and RFC 9457 `application/problem+json` errors map into the typed
 * `AdminAuthError` union the gate component renders.
 */
import type {
  AdminConfirmOk,
  AdminLoginOk,
  AdminMfaOk,
  AdminResult,
  AdminSetupOk,
  AdminAuthError,
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

async function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}/admin/auth${path}`, {
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

/** Pull an ISO-8601 instant out of the lockout detail string, if present. */
function parseUnlockAt(detail?: string): string | undefined {
  const m = detail?.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/);
  return m?.[0];
}

function classifyError(status: number, problem?: ProblemResponse): AdminAuthError {
  if (status === 400) {
    return { kind: "validation", fields: problem?.errors ?? [], detail: problem?.detail };
  }
  if (status === 429) {
    return { kind: "account_locked", unlockAt: parseUnlockAt(problem?.detail) };
  }
  if (status === 409) {
    return { kind: "already_enrolled", detail: problem?.detail };
  }
  if (status === 401) {
    // The MFA/enrolment steps use a distinct problem type so the UI can tell
    // "wrong password" from "challenge expired / wrong code".
    if (problem?.type === "/problems/admin-mfa-invalid") {
      return { kind: "mfa_invalid", detail: problem.detail };
    }
    return { kind: "invalid_credentials" };
  }
  if (status >= 500) {
    // The admin keys (ADMIN_MFA_ENCRYPTION_KEY / ADMIN_MFA_CHALLENGE_KEY) are
    // the usual cause of a 500 on this surface — loadMfaKey throws when unset.
    return { kind: "not_configured", detail: problem?.detail };
  }
  return { kind: "unknown", status, detail: problem?.detail };
}

async function map<T>(res: Response): Promise<AdminResult<T>> {
  if (res.ok) {
    return { ok: true, value: (await res.json()) as T };
  }
  return { ok: false, error: classifyError(res.status, await readProblem(res)) };
}

// ─── Public surface ──────────────────────────────────────────────────────────

/** Step 1: verify the password. Returns the challenge + which step is next. */
export async function adminLogin(input: {
  email: string;
  password: string;
}): Promise<AdminResult<AdminLoginOk>> {
  try {
    return await map<AdminLoginOk>(
      await adminFetch("/login", { method: "POST", body: JSON.stringify(input) }),
    );
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}

/** Step 2 (already enrolled): verify a TOTP or recovery code → opens session. */
export async function adminMfa(input: {
  challenge: string;
  code: string;
}): Promise<AdminResult<AdminMfaOk>> {
  try {
    return await map<AdminMfaOk>(
      await adminFetch("/mfa", { method: "POST", body: JSON.stringify(input) }),
    );
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}

/** First-login enrolment, part 1: provision a secret + otpauth URI. */
export async function adminMfaSetup(input: {
  challenge: string;
}): Promise<AdminResult<AdminSetupOk>> {
  try {
    return await map<AdminSetupOk>(
      await adminFetch("/mfa/setup", { method: "POST", body: JSON.stringify(input) }),
    );
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}

/** Enrolment part 2: confirm a code → enable MFA, open session, return codes. */
export async function adminMfaConfirm(input: {
  challenge: string;
  code: string;
}): Promise<AdminResult<AdminConfirmOk>> {
  try {
    return await map<AdminConfirmOk>(
      await adminFetch("/mfa/setup/confirm", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
  } catch (err) {
    return { ok: false, error: { kind: "network", cause: err } };
  }
}

/** Clear the admin session. Idempotent. */
export async function adminLogout(): Promise<void> {
  try {
    await adminFetch("/logout", { method: "POST" });
  } catch {
    /* best-effort — the cookie is cleared server-side when reachable */
  }
}
