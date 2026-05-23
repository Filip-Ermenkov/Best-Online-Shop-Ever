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
 * Editable profile shape, sibling to `AuthUser` in the GET /auth/me /
 * PATCH /auth/me responses. Discriminated union by `kind`, mirroring the
 * `customer_profiles` vs `corporate_profiles` split in the DB schema.
 *
 * Identity-only consumers (header, route guards) read AuthUser. Profile-
 * editing UI reads Profile. The two are sibling fields rather than nested
 * to keep AuthUser's shape stable across slices (this slice only added a
 * sibling field — no breaking changes to anything that previously consumed
 * just `user`).
 */
export type Profile =
  | {
      kind: "personal";
      fullName: string;
      phone: string;
    }
  | {
      kind: "corporate";
      companyName: string;
      /** Read-only — backend rejects PATCH attempts to set this. Surfaced so the form can show it as a disabled input. */
      eik: string;
      vatNumber: string | null;
      registeredAddress: string;
      mol: string;
      contactName: string;
      contactPhone: string;
    };

/**
 * Input for `updateProfile()`. Every field is optional — only the fields you
 * pass are written. The backend enforces account-type-aware field allowlisting
 * (sending `companyName` from a personal account is a 400 with a per-field
 * error), so the UI's render-time gating is defence-in-depth rather than
 * load-bearing.
 *
 * `vatNumber: null` (explicit) means "clear the field"; `vatNumber:
 * undefined` (or omitted) means "no change". Every other field follows the
 * standard partial-update convention.
 */
export type UpdateProfileInput = {
  // Personal
  fullName?: string;
  phone?: string;
  // Corporate
  companyName?: string;
  vatNumber?: string | null;
  registeredAddress?: string;
  mol?: string;
  contactName?: string;
  contactPhone?: string;
};

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
  /**
   * The submitted password was found in the Have I Been Pwned breach corpus.
   * Server returns 400 with type=/problems/breached-password and a structured
   * `errors[]` entry on either "password" (register) or "newPassword" (reset).
   * The UI should keep the form open with a field-level message in the user's
   * language — the server's English `detail` is a fallback, not the primary
   * source of UX copy.
   */
  | {
      kind: "breached_password";
      fields: { path: string; message: string }[];
      detail?: string;
    }
  /**
   * Backend rejected the change-password request because newPassword equals
   * currentPassword. Backend returns 400 with type=/problems/same-password and
   * a single `errors[]` entry on "newPassword". The UI should render an
   * inline field-level message — the user almost certainly mis-filled the
   * form rather than tried to game the system.
   *
   * Distinct from the breached-password kind: same-password is a UX nudge
   * (no security control — Argon2id rotates salt regardless), whereas
   * breached-password is a hard "this password is in a known breach corpus"
   * rejection.
   */
  | {
      kind: "same_password";
      fields: { path: string; message: string }[];
      detail?: string;
    }
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
