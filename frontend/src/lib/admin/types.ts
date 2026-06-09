/**
 * Types for the admin authentication client (lib/admin/client.ts).
 *
 * Mirrors the backend `/admin/auth/*` contract (backend/shop-api/src/routes/
 * admin/auth.ts) and follows the same discriminated-union error posture as
 * lib/addresses/types.ts so the gate component can branch exhaustively at the
 * type level. Hand-written (small, frontend-owned) rather than imported from
 * `@shop/api` — the wire shapes here are tiny and stable.
 */

/** The admin as returned by /admin/auth/{mfa,setup/confirm,me}. */
export interface AdminUser {
  id: string;
  email: string;
  role: "admin";
  emailVerifiedAt: string | null;
}

/** /admin/auth/login → password accepted; which second step to take next. */
export type AdminLoginStatus = "mfa_required" | "enrollment_required";

export interface AdminLoginOk {
  status: AdminLoginStatus;
  /** Short-lived signed token to present at the next step. */
  challenge: string;
}

export interface AdminMfaOk {
  user: AdminUser;
  recoveryCodeUsed: boolean;
  recoveryCodesRemaining: number | null;
}

export interface AdminSetupOk {
  /** Base32 secret for manual entry into an authenticator app. */
  secret: string;
  /** otpauth:// URI (render as QR or paste into the app). */
  otpauthUri: string;
  /** Fresh enrolment challenge to present at the confirm step. */
  challenge: string;
}

export interface AdminConfirmOk {
  user: AdminUser;
  /** The single-use recovery codes — shown exactly once. */
  recoveryCodes: string[];
}

/**
 * Discriminated error union across every /admin/auth/* call. Mirrors the
 * backend's RFC 9457 problem `type`s.
 */
export type AdminAuthError =
  /** /login 401 — wrong password, unknown email, or non-admin. Uniform. */
  | { kind: "invalid_credentials" }
  /** 429 — 30-min/5-fail admin lockout. `unlockAt` parsed from the detail. */
  | { kind: "account_locked"; unlockAt?: string }
  /** /mfa or /mfa/setup* 401 — challenge expired/invalid OR code didn't verify. */
  | { kind: "mfa_invalid"; detail?: string }
  /** /mfa/setup* 409 — MFA already enrolled for this admin. */
  | { kind: "already_enrolled"; detail?: string }
  /** 500 — the admin MFA keys aren't configured in the API env. */
  | { kind: "not_configured"; detail?: string }
  /** 400 — request validation (e.g. a non-6-digit confirm code). */
  | { kind: "validation"; fields: { path: string; message: string }[]; detail?: string }
  /** Transport failure (API unreachable). */
  | { kind: "network"; cause: unknown }
  | { kind: "unknown"; status: number; detail?: string };

export type AdminResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AdminAuthError };
