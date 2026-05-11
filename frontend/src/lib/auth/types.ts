/**
 * Authenticated user as exposed by GET /auth/me and POST /auth/login.
 *
 * Mirrors the backend's `PublicUser` Zod schema in
 * backend/shop-api/src/routes/auth.ts. Kept hand-written rather than imported
 * from `@shop/api` because the Hono RPC types only describe the wire shape —
 * it's clearer (and easier to refactor consumers of) to have a small,
 * frontend-owned interface for identity.
 */
export interface AuthUser {
  id: string;
  email: string;
  role: "admin" | "customer";
  accountType: "personal" | "corporate" | null;
  emailVerifiedAt: string | null;
  /** From customer_profiles.full_name (or contact_name for corporate). Null for admins. */
  fullName: string | null;
}

/**
 * Discriminated error union. Every UI auth path branches on `kind`.
 *
 * Why not just throw? Because the shape of an "invalid credentials" error is
 * fundamentally different from "field-level validation failure" or "account
 * locked, retry at..." — and the UI needs to render them differently. A
 * typed Result keeps the branching exhaustive at the type level.
 */
export type AuthError =
  | { kind: "validation"; fields: { path: string; message: string }[]; detail?: string }
  | { kind: "invalid_credentials"; detail?: string }
  | { kind: "account_locked"; detail?: string; unlockAt?: string }
  | { kind: "resend_rate_limited"; detail?: string }
  /**
   * The reset link was unknown / expired / already consumed. The backend
   * returns `application/problem+json` with type=/problems/invalid-reset-token
   * for all three cases — we deliberately do NOT distinguish them in the UI
   * either, to mirror the no-enumeration contract.
   */
  | { kind: "invalid_reset_token"; detail?: string }
  /**
   * The email-change verify link was unknown / expired / already consumed /
   * destination-now-conflicts. Same generic-400 contract as invalid-reset-token
   * — distinguishing the four would defeat enumeration resistance, and the
   * UI handles all four with the same "request a new link" copy.
   */
  | { kind: "invalid_email_change_token"; detail?: string }
  | { kind: "unauthenticated" }
  | { kind: "network"; cause: unknown }
  | { kind: "unknown"; status: number; detail?: string };

export type AuthResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AuthError };

export interface LoginInput {
  email: string;
  password: string;
  rememberMe: boolean;
}

export interface RegisterInput {
  email: string;
  password: string;
  fullName: string;
  phone: string;
}
