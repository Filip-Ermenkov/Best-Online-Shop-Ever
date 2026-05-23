import {
  checkPasswordBreached,
  DUMMY_PASSWORD_HASH,
  hashPassword,
  needsRehash,
  verifyPassword,
} from "@shop/auth";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { type DbClient, schema } from "@shop/db";
import { and, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import {
  clearSessionCookie,
  sessionCookieName,
  setSessionCookie,
} from "../lib/cookies.js";
import { getDb } from "../lib/db.js";
import {
  consumeSignupVerificationToken,
  evaluateResendRateLimit,
  issueSignupVerificationToken,
  sendSignupVerificationEmail,
} from "../lib/email-verification.js";
import {
  consumeResetToken,
  evaluateForgotPasswordRateLimit,
  issueResetToken,
  sendPasswordChangedNotification,
  sendPasswordResetEmail,
  validateResetToken,
} from "../lib/password-reset.js";
import {
  consumeEmailChangeToken,
  evaluateEmailChangeRateLimit,
  issueEmailChangeToken,
  sendEmailChangeAlertEmail,
  sendEmailChangeVerifyEmail,
  sendEmailChangedNotification,
  validateEmailChangeToken,
} from "../lib/email-change.js";
import { parseEnv } from "../lib/env.js";
import { ApiError, ProblemSchema, badRequest, internal } from "../lib/errors.js";
import { logger as baseLogger } from "../lib/logger.js";
import { getLockoutState, recordAttempt } from "../lib/lockout.js";
import { normalizeBulgarianPhone } from "../lib/phone.js";
import {
  createSession,
  deleteAllSessionsForUser,
  deleteSession,
} from "../lib/sessions.js";
import { validationHook } from "../lib/validation-hook.js";
import { requireAuth, type AuthVariables } from "../middleware/auth.js";

// ─── Reusable schemas ──────────────────────────────────────────────────────

const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("Must be a valid email address")
  .max(254, "Email is too long")
  .openapi({ example: "ivan@example.com" });

/**
 * Password rules — NIST SP 800-63B Rev. 4 (finalised mid-2025).
 *
 *   - 12-character minimum. NIST's text recommends ≥15 chars when the
 *     password is the only authenticator. We accept the increased
 *     credential-stuffing risk of 12 in exchange for sign-up completion
 *     rate; the shop is cash-on-delivery with no card data, and the
 *     compensating controls are (a) Argon2id at OWASP 2026 params,
 *     (b) per-email lockout 5/15min, and (c) HIBP breached-password
 *     screening on this endpoint (see register handler).
 *   - 1024-character ceiling for cost protection only. NIST asks for
 *     SHOULD-accept at least 64; 1024 is well over.
 *   - No composition rules. NIST 800-63B Rev. 4 explicitly DEPRECATES
 *     "must contain upper/lower/digit/symbol" rules — they push users
 *     toward predictable templates (`Password1!`) without improving
 *     resistance to dictionary or credential-stuffing attacks. The
 *     strength comes from length and from screening against breach
 *     corpora, not from forced character classes.
 *
 * Composition-rule removal applies to BOTH /register and /reset-password,
 * since both ingest a fresh password via this schema.
 */
const PasswordSchema = z
  .string()
  .min(12, "Password must be at least 12 characters")
  .max(1024, "Password is unreasonably long")
  .openapi({
    description:
      "≥12 characters, ≤1024. No composition rules. Will be rejected if found in the HIBP breach corpus.",
  });

const FullNameSchema = z.string().trim().min(1, "Name is required").max(120);
const PhoneSchema = z.string().trim().min(3, "Phone is required").max(40);

const PublicUserSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string(),
    role: z.enum(["admin", "customer"]),
    accountType: z.enum(["personal", "corporate"]).nullable(),
    emailVerifiedAt: z.string().nullable(),
    fullName: z.string().nullable(),
  })
  .openapi("PublicUser");

// ─── Profile schemas ───────────────────────────────────────────────────────
//
// Editable profile data, returned on GET /auth/me and PATCH /auth/me. Modelled
// as a discriminated union by `kind` so consumers branch on it the same way
// the database schema does (separate customer_profiles vs corporate_profiles
// tables — see backend/db/src/schema/users.ts).
//
// Deliberately omitted from BOTH read and write:
//   - email           — has a dedicated multi-step flow at /auth/email-change.
//   - password        — has a dedicated flow at /auth/change-password.
//   - role            — set by the system at registration; not user-mutable.
//   - accountType     — set at registration; switching from personal to
//                       corporate is effectively a different account and would
//                       need a migration of the linked profile row anyway.
//   - eik (corporate) — the legal business identifier. Editing it would mean
//                       pretending to be a different company. If the user truly
//                       changes their legal entity, the right move is a new
//                       registration. Returned in the read response so the
//                       form can show it as a disabled field.

const PersonalProfileSchema = z
  .object({
    kind: z.literal("personal"),
    fullName: z.string(),
    phone: z.string(),
  })
  .openapi("PersonalProfile");

const CorporateProfileSchema = z
  .object({
    kind: z.literal("corporate"),
    companyName: z.string(),
    /** Read-only — see the comment block above. */
    eik: z.string(),
    vatNumber: z.string().nullable(),
    registeredAddress: z.string(),
    mol: z.string(),
    contactName: z.string(),
    contactPhone: z.string(),
  })
  .openapi("CorporateProfile");

const ProfileSchema = z
  .discriminatedUnion("kind", [PersonalProfileSchema, CorporateProfileSchema])
  .openapi("Profile");

// ─── Register ──────────────────────────────────────────────────────────────

const RegisterRequestSchema = z
  .object({
    email: EmailSchema,
    password: PasswordSchema,
    fullName: FullNameSchema,
    phone: PhoneSchema,
  })
  .openapi("RegisterRequest");

const RegisterResponseSchema = z
  .object({ ok: z.literal(true) })
  .openapi("RegisterResponse");

const registerRoute = createRoute({
  method: "post",
  path: "/register",
  tags: ["auth"],
  summary: "Register a personal customer account",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: RegisterRequestSchema } },
    },
  },
  responses: {
    200: {
      description:
        "Registration accepted. Always returns the same shape regardless of whether the email was already registered, to prevent enumeration.",
      content: { "application/json": { schema: RegisterResponseSchema } },
    },
    400: {
      description:
        "Validation error OR the supplied password appears in the HIBP breach corpus. The two cases share status but differ by `type`: the default validation problem (type=\"about:blank\") vs /problems/breached-password. Both carry a field-level entry in `errors[]` for inline rendering.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

// ─── Login ─────────────────────────────────────────────────────────────────

const LoginRequestSchema = z
  .object({
    email: EmailSchema,
    password: z.string().min(1).max(1024),
    rememberMe: z.boolean().default(false),
  })
  .openapi("LoginRequest");

const LoginResponseSchema = z
  .object({ user: PublicUserSchema })
  .openapi("LoginResponse");

const loginRoute = createRoute({
  method: "post",
  path: "/login",
  tags: ["auth"],
  summary: "Log in with email and password",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: LoginRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Login succeeded — sets the session cookie and returns the user.",
      content: { "application/json": { schema: LoginResponseSchema } },
    },
    401: {
      description: "Invalid credentials. Identical body for unknown email and wrong password.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    429: {
      description: "Too many failed attempts — account temporarily locked.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

// ─── Logout ────────────────────────────────────────────────────────────────

const logoutRoute = createRoute({
  method: "post",
  path: "/logout",
  tags: ["auth"],
  summary: "Log out the current session",
  responses: {
    204: { description: "Session cleared. Idempotent — safe to call when not logged in." },
  },
});

// ─── Me ────────────────────────────────────────────────────────────────────

const MeResponseSchema = z
  .object({
    user: PublicUserSchema,
    /**
     * Editable profile shape, sibling to `user`. Null when the row is missing
     * (admin accounts always; an inconsistent customer row should never
     * occur but is tolerated rather than 500-ing). Discriminated by `kind`.
     */
    profile: ProfileSchema.nullable(),
  })
  .openapi("MeResponse");

const meRoute = createRoute({
  method: "get",
  path: "/me",
  tags: ["auth"],
  summary: "Return the currently authenticated user and editable profile",
  responses: {
    200: {
      description: "The user behind the active session cookie + their profile.",
      content: { "application/json": { schema: MeResponseSchema } },
    },
    401: {
      description: "No active session.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

// ─── Update me (PATCH /auth/me) ───────────────────────────────────────────
//
// Partial update of the editable profile fields. Account-type-aware:
//   - personal:  fullName, phone
//   - corporate: companyName, vatNumber, registeredAddress, mol,
//                contactName, contactPhone
//
// Semantics:
//   - HTTP PATCH per RFC 5789 (partial update). NOT RFC 7396 merge-patch:
//     we use a typed Zod schema rather than the implicit "null = delete"
//     convention; that gives us field-level validation messages the UI
//     can render inline, which merge-patch's freeform shape can't.
//   - Every field is OPTIONAL. Sending none returns the current state
//     (no-op short-circuit; the row's updated_at is NOT bumped).
//   - Unknown keys are REJECTED with 400 (Zod `.strict()`). This is a
//     defence-in-depth measure against a confused-deputy attempt to set
//     fields we don't expose (role, email, accountType, eik).
//   - Submitting a field that belongs to the OTHER account type (e.g. a
//     personal account trying to PATCH `companyName`) is rejected 400 with
//     a per-field error pointing to the rejected path.
//   - Phone numbers are normalised to E.164 before persisting. Anything
//     normalizeBulgarianPhone() rejects produces a 400 with a per-field
//     error on `phone` or `contactPhone`.
//   - VAT number (corporate) MAY be set to null explicitly to clear it.
//     This is the only field where null carries meaning; for the rest
//     omitting the key means "no change".
//
// Why no `If-Match` / ETag:
//   - The only writer to a user's own profile is the user themself. The
//     "concurrent edit" case is "logged in on two tabs at once"; last-write-
//     wins is the right behaviour there. Adding optimistic locking would
//     buy nothing against any actual threat model.
//
// Audit log:
//   - Structured Pino log `profile_updated` with the LIST OF FIELD NAMES
//     that changed (never the values — those are PII). GDPR Art. 16
//     "record of processing activities" is satisfied by the CloudWatch
//     log retention. We deliberately do NOT write to admin_audit_log
//     (that table is for actor=admin actions on third parties).

const UpdateMeRequestSchema = z
  .object({
    // Personal-account fields. Optional; absence means "no change".
    fullName: z.string().trim().min(1, "Name is required").max(120).optional(),
    phone: z.string().trim().min(3, "Phone is required").max(40).optional(),

    // Corporate-account fields. Optional; absence means "no change".
    // EIK is intentionally not present — see ProfileSchema comment above.
    companyName: z.string().trim().min(1, "Company name is required").max(200).optional(),
    /**
     * VAT number. Bulgarian format is "BG" + 9 or 10 digits per Council
     * Directive 2006/112/EC, Annex I. The literal-null case is accepted to
     * let a previously-VAT-registered company clear the field if they
     * deregister. Empty string is treated as null at handler level.
     */
    vatNumber: z
      .string()
      .trim()
      .max(20)
      .regex(/^BG\d{9,10}$/, "VAT number must be Bulgarian format: BG + 9 or 10 digits")
      .nullable()
      .optional(),
    registeredAddress: z.string().trim().min(3).max(300).optional(),
    mol: z.string().trim().min(1).max(120).optional(),
    contactName: z.string().trim().min(1).max(120).optional(),
    contactPhone: z.string().trim().min(3).max(40).optional(),
  })
  // .strict() — reject unknown keys at the Zod layer. A 400 fires with a
  // validation error before the handler runs. Defence in depth against
  // confused-deputy attempts to set role / email / accountType / eik.
  .strict()
  .openapi("UpdateMeRequest");

const updateMeRoute = createRoute({
  method: "patch",
  path: "/me",
  tags: ["auth"],
  summary: "Update the editable profile fields of the current user",
  description:
    "Partial update of the authenticated user's profile. Every field is " +
    "optional; only the ones present in the body are written. The endpoint " +
    "is account-type-aware: personal customers can update fullName + phone, " +
    "corporate customers can update companyName + VAT + address + MOL + " +
    "contact name + contact phone. EIK, email, password, role, and account " +
    "type are not editable here — they have their own flows. Phone numbers " +
    "are normalised to E.164.",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: UpdateMeRequestSchema } },
    },
  },
  responses: {
    200: {
      description:
        "Profile updated (or no-op if no fields changed). Returns the full " +
        "current state — same shape as GET /auth/me.",
      content: { "application/json": { schema: MeResponseSchema } },
    },
    400: {
      description:
        "Validation error: unknown field, invalid phone, VAT format wrong, " +
        "or a field belonging to the other account type was sent.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    401: {
      description: "No active session.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

// ─── Verify email ──────────────────────────────────────────────────────────

const VerifyEmailRequestSchema = z
  .object({
    token: z.string().trim().min(20).max(200),
  })
  .openapi("VerifyEmailRequest");

const VerifyEmailResponseSchema = z
  .object({ ok: z.literal(true) })
  .openapi("VerifyEmailResponse");

const verifyEmailRoute = createRoute({
  method: "post",
  path: "/verify-email",
  tags: ["auth"],
  summary: "Confirm an email address using a token from the verification link",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: VerifyEmailRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Token consumed; the user's email is now verified.",
      content: { "application/json": { schema: VerifyEmailResponseSchema } },
    },
    400: {
      description:
        "Token is invalid, expired, or already consumed. Same body for all three to prevent enumeration of token state.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

// ─── Resend verification ───────────────────────────────────────────────────

const ResendVerificationResponseSchema = z
  .object({ ok: z.literal(true) })
  .openapi("ResendVerificationResponse");

const resendVerificationRoute = createRoute({
  method: "post",
  path: "/resend-verification",
  tags: ["auth"],
  summary: "Resend the email-verification link to the current user",
  request: {},
  responses: {
    200: {
      description:
        "Always 200 unless rate-limited. If the user is already verified the response is the same — no enumeration of state.",
      content: {
        "application/json": { schema: ResendVerificationResponseSchema },
      },
    },
    401: {
      description: "No active session.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    429: {
      description: "Resend rate limit exceeded.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

// ─── Forgot password ───────────────────────────────────────────────────────

const ForgotPasswordRequestSchema = z
  .object({
    email: EmailSchema,
  })
  .openapi("ForgotPasswordRequest");

const ForgotPasswordResponseSchema = z
  .object({ ok: z.literal(true) })
  .openapi("ForgotPasswordResponse");

const forgotPasswordRoute = createRoute({
  method: "post",
  path: "/forgot-password",
  tags: ["auth"],
  summary: "Request a password-reset email",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: ForgotPasswordRequestSchema } },
    },
  },
  responses: {
    200: {
      description:
        "Always 200 — the response body is identical regardless of whether the email is registered, regardless of internal rate-limiting, regardless of email-send success. This is the OWASP-recommended enumeration-resistant contract.",
      content: { "application/json": { schema: ForgotPasswordResponseSchema } },
    },
    400: {
      description: "Validation error (e.g. malformed email).",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

// ─── Check reset token (read-only validation, no consumption) ──────────────

const CheckResetTokenRequestSchema = z
  .object({
    token: z.string().trim().min(20).max(200),
  })
  .openapi("CheckResetTokenRequest");

const CheckResetTokenResponseSchema = z
  .object({ valid: z.literal(true) })
  .openapi("CheckResetTokenResponse");

const checkResetTokenRoute = createRoute({
  method: "post",
  path: "/reset-password/check",
  tags: ["auth"],
  summary:
    "Validate a reset token WITHOUT consuming it — used by the reset page to fail fast on a dead link",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CheckResetTokenRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Token is live (exists, unexpired, unconsumed, user OK).",
      content: { "application/json": { schema: CheckResetTokenResponseSchema } },
    },
    400: {
      description:
        "Token is unknown, expired, or already consumed. Same generic body — no enumeration of token state.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

// ─── Reset password ────────────────────────────────────────────────────────

const ResetPasswordRequestSchema = z
  .object({
    token: z.string().trim().min(20).max(200),
    newPassword: PasswordSchema,
  })
  .openapi("ResetPasswordRequest");

const ResetPasswordResponseSchema = z
  .object({ ok: z.literal(true) })
  .openapi("ResetPasswordResponse");

const resetPasswordRoute = createRoute({
  method: "post",
  path: "/reset-password",
  tags: ["auth"],
  summary: "Set a new password using a token from the reset email",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: ResetPasswordRequestSchema } },
    },
  },
  responses: {
    200: {
      description:
        "Password rotated; all sessions for the user have been dropped. The caller must redirect to /login — the session cookie they may be carrying is now dead.",
      content: { "application/json": { schema: ResetPasswordResponseSchema } },
    },
    400: {
      description:
        "Token is invalid/expired/consumed, OR newPassword failed strength validation, OR newPassword appears in the HIBP breach corpus. The three cases are distinguished by `type`: /problems/invalid-reset-token, the default validation problem with field-level errors, or /problems/breached-password.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

// ─── Change password (authenticated, self-initiated) ──────────────────────

const ChangePasswordRequestSchema = z
  .object({
    /**
     * Re-auth proof. Length-only validation (1..1024) — the strength rules
     * are irrelevant here because we're verifying against a stored hash,
     * not creating a new credential. Matches /auth/login's `password` shape.
     */
    currentPassword: z.string().min(1).max(1024),
    newPassword: PasswordSchema,
  })
  .openapi("ChangePasswordRequest");

const ChangePasswordResponseSchema = z
  .object({ ok: z.literal(true) })
  .openapi("ChangePasswordResponse");

const changePasswordRoute = createRoute({
  method: "post",
  path: "/change-password",
  tags: ["auth"],
  summary:
    "Rotate the authenticated user's password. Requires the current password as re-auth proof.",
  description:
    "Closes the OWASP ASVS V6.2 / NIST SP 800-63B-4 §5.1.1.2 'subscribers SHALL be able to change their memorized secret' control. Behaviour: (a) HIBP-screens the proposed newPassword before touching anything (no token to burn here, but consistent with /reset-password); (b) constant-time-verifies currentPassword against the stored Argon2id hash with the same DUMMY_PASSWORD_HASH posture as /login, so a stolen-cookie attacker cannot brute-force the password through this endpoint without falling into the per-email lockout shared with /login; (c) on success rotates passwordHash, drops every OTHER session for the user (keeping the caller's own session alive — industry-standard 'sign out everywhere except here' on intentional change), and sends a best-effort 'your password was changed' notification email to the account address.",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: ChangePasswordRequestSchema } },
    },
  },
  responses: {
    200: {
      description:
        "Password rotated. Other sessions dropped; this session preserved (the user stays logged in on the device that initiated the change). Notification email best-effort.",
      content: { "application/json": { schema: ChangePasswordResponseSchema } },
    },
    400: {
      description:
        "Validation error OR newPassword failed strength check (≥12 chars) OR newPassword appears in the HIBP breach corpus OR newPassword equals currentPassword. Cases distinguished by `type`: default validation (`about:blank` with field-level errors), `/problems/breached-password`, or `/problems/same-password`.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    401: {
      description:
        "No active session OR currentPassword is incorrect. Identical body for both — distinguishing them would leak whether the cookie alone is enough.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    429: {
      description:
        "Per-email lockout fired — too many incorrect currentPassword attempts inside the rolling 15-minute window. Shared counter with /auth/login (same lockout machinery), so an attacker who has a stolen cookie cannot bypass login's brute-force ceiling via this endpoint.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

// ─── Email change: request ─────────────────────────────────────────────────

const EmailChangeRequestSchema = z
  .object({
    currentPassword: z.string().min(1).max(1024),
    newEmail: EmailSchema,
  })
  .openapi("EmailChangeRequest");

const EmailChangeRequestResponseSchema = z
  .object({ ok: z.literal(true) })
  .openapi("EmailChangeRequestResponse");

const emailChangeRequestRoute = createRoute({
  method: "post",
  path: "/email-change/request",
  tags: ["auth"],
  summary:
    "Request to change the authenticated user's email address. Requires the current password as re-auth proof.",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: EmailChangeRequestSchema } },
    },
  },
  responses: {
    200: {
      description:
        "Request accepted. ALWAYS returns the same shape regardless of whether the new address is already in use or whether the internal rate-limit was hit — same enumeration-resistant contract as forgot-password. A verify link is sent to the new address; an alert is sent to the old.",
      content: {
        "application/json": { schema: EmailChangeRequestResponseSchema },
      },
    },
    400: {
      description:
        "Validation error (e.g. malformed email, or new email equal to current).",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    401: {
      description:
        "Either no active session OR the supplied current password is wrong. Identical response body for both — distinguishing them would leak whether the cookie alone is enough.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

// ─── Email change: check verify token (read-only) ──────────────────────────

const CheckEmailChangeTokenRequestSchema = z
  .object({
    token: z.string().trim().min(20).max(200),
  })
  .openapi("CheckEmailChangeTokenRequest");

const CheckEmailChangeTokenResponseSchema = z
  .object({
    valid: z.literal(true),
    newEmail: z.string().openapi({
      description:
        "The proposed new address — surfaced so the verify page can render 'you are confirming change to X' copy.",
    }),
  })
  .openapi("CheckEmailChangeTokenResponse");

const checkEmailChangeTokenRoute = createRoute({
  method: "post",
  path: "/email-change/verify/check",
  tags: ["auth"],
  summary:
    "Validate an email-change verify token WITHOUT consuming it. Used by the verify page to fail fast on a dead link.",
  request: {
    body: {
      required: true,
      content: {
        "application/json": { schema: CheckEmailChangeTokenRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Token is live; surfaces the destination address.",
      content: {
        "application/json": { schema: CheckEmailChangeTokenResponseSchema },
      },
    },
    400: {
      description:
        "Token is unknown / expired / consumed / destination conflicts. Same generic body — no enumeration of why.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

// ─── Email change: verify (consume) ────────────────────────────────────────

const VerifyEmailChangeRequestSchema = z
  .object({
    token: z.string().trim().min(20).max(200),
  })
  .openapi("VerifyEmailChangeRequest");

const VerifyEmailChangeResponseSchema = z
  .object({ ok: z.literal(true) })
  .openapi("VerifyEmailChangeResponse");

const verifyEmailChangeRoute = createRoute({
  method: "post",
  path: "/email-change/verify",
  tags: ["auth"],
  summary:
    "Confirm an email change using the token from the verification link. Rotates users.email, marks the new address verified, drops all sessions, sends a notification to the OLD address.",
  request: {
    body: {
      required: true,
      content: {
        "application/json": { schema: VerifyEmailChangeRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description:
        "Email rotated; all sessions dropped. The caller must redirect to /login — the user must re-authenticate with the new address.",
      content: {
        "application/json": { schema: VerifyEmailChangeResponseSchema },
      },
    },
    400: {
      description:
        "Token is invalid / expired / consumed / destination conflicts. Same generic body as the check endpoint.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

// ─── Breached-password guard ───────────────────────────────────────────────

/**
 * Reject the request with a 400 RFC 9457 Problem if the supplied password
 * is in the HIBP breach corpus. Fail-open semantics: a HIBP outage logs a
 * warning and lets the password through, since we'd rather accept signups
 * during third-party degradation than couple our availability to theirs.
 *
 * `field` controls the structured error path so the frontend can mark the
 * right input ("password" on register, "newPassword" on reset).
 */
async function guardAgainstBreachedPassword(
  plain: string,
  field: "password" | "newPassword",
  log: typeof baseLogger,
): Promise<void> {
  // Env-controlled kill switch — see env.ts BREACHED_PASSWORD_CHECK_ENABLED.
  // Tests default this to false to keep the suite off the public HIBP API;
  // the dedicated HIBP test re-enables it locally with a stubbed fetch.
  if (!parseEnv().BREACHED_PASSWORD_CHECK_ENABLED) return;
  const verdict = await checkPasswordBreached(plain);
  if (!verdict.checkSucceeded) {
    log?.warn(
      { field },
      "breached_password_check_unavailable",
    );
    return; // fail open
  }
  if (verdict.breached) {
    log?.info(
      { field, occurrences: verdict.occurrences },
      "breached_password_rejected",
    );
    // Distinct `type` URI so the frontend can switch on kind and render
    // a localized message instead of having to parse the English `detail`.
    // The structured `errors[]` entry preserves the per-field association
    // the UI needs to highlight the right input.
    throw new ApiError({
      type: "/problems/breached-password",
      title: "Bad Request",
      status: 400,
      detail:
        "This password has appeared in a known data breach. Please choose a different one.",
      errors: [
        {
          path: field,
          message:
            "This password has appeared in a known data breach. Please choose a different one.",
        },
      ],
    });
  }
}

// ─── Router ────────────────────────────────────────────────────────────────

export const authRoutes = new OpenAPIHono<{ Variables: AuthVariables }>({
  defaultHook: validationHook,
});

authRoutes.openapi(registerRoute, async (c) => {
  const body = c.req.valid("json");
  const db = getDb();
  const log = baseLogger;

  // HIBP check first — independent of email existence so the 400/200 split
  // does not give an attacker a cheap way to distinguish "email taken" from
  // "fresh + good password". Both terminal branches stay 200; the only 400
  // is "your password is in a known breach", which is a quality signal
  // about the password, not about the email.
  await guardAgainstBreachedPassword(body.password, "password", log);

  const [existing] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(
      and(eq(schema.users.email, body.email), isNull(schema.users.deletedAt)),
    )
    .limit(1);

  if (existing) {
    return c.json({ ok: true } as const, 200);
  }

  const passwordHash = await hashPassword(body.password);

  const created = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.users)
      .values({
        email: body.email,
        passwordHash,
        role: "customer",
        accountType: "personal",
      })
      .returning();

    const user = inserted[0];
    if (!user) throw internal("Failed to create user");

    await tx.insert(schema.customerProfiles).values({
      userId: user.id,
      fullName: body.fullName,
      phone: body.phone,
    });

    return user;
  });

  try {
    const issued = await issueSignupVerificationToken({ userId: created.id });
    await sendSignupVerificationEmail({
      to: body.email,
      token: issued.token,
      fullName: body.fullName,
      logger: log,
    });
  } catch (err) {
    log?.error({ err }, "verification_token_issue_failed");
  }

  return c.json({ ok: true } as const, 200);
});

authRoutes.openapi(loginRoute, async (c) => {
  const body = c.req.valid("json");
  const db = getDb();

  const lockout = await getLockoutState(body.email);
  if (lockout.locked) {
    throw new ApiError({
      type: "/problems/account-locked",
      title: "Too Many Attempts",
      status: 429,
      detail: lockout.unlockAt
        ? `Account temporarily locked. Try again after ${lockout.unlockAt.toISOString()}.`
        : "Account temporarily locked due to too many failed attempts.",
    });
  }

  const [user] = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      passwordHash: schema.users.passwordHash,
      role: schema.users.role,
      accountType: schema.users.accountType,
      emailVerifiedAt: schema.users.emailVerifiedAt,
      deletedAt: schema.users.deletedAt,
    })
    .from(schema.users)
    .where(eq(schema.users.email, body.email))
    .limit(1);

  const targetHash = user && !user.deletedAt
    ? user.passwordHash
    : await DUMMY_PASSWORD_HASH;
  const ok = await verifyPassword(targetHash, body.password);

  const ip = clientIp(c);
  const ua = c.req.header("user-agent") ?? null;
  const isRealSuccess = ok && !!user && !user.deletedAt;
  await recordAttempt({
    email: body.email,
    success: isRealSuccess,
    ipAddress: ip,
    userAgent: ua,
  });

  if (!isRealSuccess || !user) {
    throw new ApiError({
      type: "about:blank",
      title: "Unauthorized",
      status: 401,
      detail: "Invalid email or password.",
    });
  }

  if (needsRehash(user.passwordHash)) {
    const upgraded = await hashPassword(body.password);
    await db
      .update(schema.users)
      .set({ passwordHash: upgraded })
      .where(eq(schema.users.id, user.id));
  }

  const { token } = await createSession({
    userId: user.id,
    rememberMe: body.rememberMe,
    ipAddress: ip,
    userAgent: ua,
  });
  setSessionCookie(c, token, { rememberMe: body.rememberMe });

  const fullName = await resolveFullName(db, user.id, user.role);

  return c.json(
    {
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        accountType: user.accountType,
        emailVerifiedAt: user.emailVerifiedAt
          ? user.emailVerifiedAt.toISOString()
          : null,
        fullName,
      },
    },
    200,
  );
});

authRoutes.openapi(logoutRoute, async (c) => {
  const token = getCookie(c, sessionCookieName());
  if (token) {
    await deleteSession(token);
  }
  clearSessionCookie(c);
  return c.body(null, 204);
});

authRoutes.use(meRoute.path, requireAuth);
authRoutes.openapi(meRoute, async (c) => {
  const user = c.get("user");
  if (!user) {
    throw new ApiError({
      type: "about:blank",
      title: "Unauthorized",
      status: 401,
      detail: "Authentication is required.",
    });
  }
  const db = getDb();
  // Two reads in parallel — fullName comes from the same tables resolveProfile
  // walks, but resolveFullName collapses the result to a single string for
  // the PublicUser shape, while resolveProfile returns the full editable
  // record. They could share a query; the duplication is intentional —
  // resolveFullName must keep working for the eight other endpoints that
  // need just the display name without paying for the rest of the row.
  const [fullName, profile] = await Promise.all([
    resolveFullName(db, user.id, user.role),
    resolveProfile(db, user.id, user.role, user.accountType),
  ]);
  return c.json(
    {
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        accountType: user.accountType,
        emailVerifiedAt: user.emailVerifiedAt
          ? user.emailVerifiedAt.toISOString()
          : null,
        fullName,
      },
      profile,
    },
    200,
  );
});

// PATCH /auth/me — partial profile update. See route comment block above
// for the full design (rejection rules, audit log, no-op semantics).
authRoutes.use(updateMeRoute.path, requireAuth);
authRoutes.openapi(updateMeRoute, async (c) => {
  const body = c.req.valid("json");
  const user = c.get("user");
  if (!user) {
    throw new ApiError({
      type: "about:blank",
      title: "Unauthorized",
      status: 401,
      detail: "Authentication is required.",
    });
  }
  const log = baseLogger;
  const db = getDb();

  // Admin accounts have no profile row of either kind to edit. We could
  // build an admin-profile surface later; for now this endpoint is
  // customer-only.
  if (user.role !== "customer" || !user.accountType) {
    throw new ApiError({
      type: "about:blank",
      title: "Forbidden",
      status: 403,
      detail: "Profile editing is not available for this account type.",
    });
  }

  // ── Account-type field-allowlist enforcement ────────────────────────────
  // Zod's .strict() already rejected unknown keys at the schema layer.
  // Here we reject keys that ARE in the schema but belong to the other
  // account type. Sending companyName on a personal account is a 400 with
  // a per-field error so the UI can highlight the offending input.
  const PERSONAL_FIELDS = ["fullName", "phone"] as const;
  const CORPORATE_FIELDS = [
    "companyName",
    "vatNumber",
    "registeredAddress",
    "mol",
    "contactName",
    "contactPhone",
  ] as const;
  const allowed: readonly string[] =
    user.accountType === "personal" ? PERSONAL_FIELDS : CORPORATE_FIELDS;
  const submittedKeys = Object.entries(body)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k);
  const rejected = submittedKeys.filter((k) => !allowed.includes(k));
  if (rejected.length > 0) {
    throw badRequest(
      `Fields not editable on a ${user.accountType} account: ${rejected.join(", ")}`,
      rejected.map((path) => ({
        path,
        message: `Field "${path}" is not valid for a ${user.accountType} account.`,
      })),
    );
  }

  // ── Phone normalisation ─────────────────────────────────────────────────
  // Both fields share the same Bulgarian E.164 normaliser. Any value we
  // can't canonicalise produces a 400 with a per-field error so the UI
  // can render a localised hint against the right input.
  if (typeof body.phone === "string") {
    const normalized = normalizeBulgarianPhone(body.phone);
    if (!normalized) {
      throw badRequest("Invalid Bulgarian phone number.", [
        {
          path: "phone",
          message:
            "Phone must be a valid Bulgarian number (e.g. +359 88 812 3456).",
        },
      ]);
    }
    body.phone = normalized;
  }
  if (typeof body.contactPhone === "string") {
    const normalized = normalizeBulgarianPhone(body.contactPhone);
    if (!normalized) {
      throw badRequest("Invalid Bulgarian contact phone number.", [
        {
          path: "contactPhone",
          message:
            "Contact phone must be a valid Bulgarian number (e.g. +359 88 812 3456).",
        },
      ]);
    }
    body.contactPhone = normalized;
  }

  // ── No-op short-circuit ─────────────────────────────────────────────────
  // If the user submitted zero changes (or every submitted value matches
  // the stored value), don't write. This keeps updated_at honest — it
  // really did NOT change — and skips the audit log entry. Cheap PATCHes
  // are the common case (e.g., the UI saves the whole form even when the
  // user only touched one field; the values for the others come back
  // identical to what's stored).
  const currentProfile = await resolveProfile(
    db,
    user.id,
    user.role,
    user.accountType,
  );
  if (!currentProfile) {
    // Customer with no profile row — schema invariant violation. The
    // registration flow inserts one transactionally so this should be
    // unreachable. If it is reached, returning 500 surfaces the bug
    // rather than silently masking it with an INSERT-instead-of-UPDATE.
    throw internal("Profile row is missing for this user.");
  }

  const changedFields: string[] = [];
  if (currentProfile.kind === "personal") {
    if (typeof body.fullName === "string" && body.fullName !== currentProfile.fullName) {
      changedFields.push("fullName");
    }
    if (typeof body.phone === "string" && body.phone !== currentProfile.phone) {
      changedFields.push("phone");
    }
  } else {
    if (
      typeof body.companyName === "string" &&
      body.companyName !== currentProfile.companyName
    ) {
      changedFields.push("companyName");
    }
    // vatNumber: undefined = no-op, null = clear, string = set. Compare the
    // intent against the stored value.
    if (body.vatNumber !== undefined) {
      const stored = currentProfile.vatNumber;
      const incoming = body.vatNumber; // string | null
      if (incoming !== stored) changedFields.push("vatNumber");
    }
    if (
      typeof body.registeredAddress === "string" &&
      body.registeredAddress !== currentProfile.registeredAddress
    ) {
      changedFields.push("registeredAddress");
    }
    if (typeof body.mol === "string" && body.mol !== currentProfile.mol) {
      changedFields.push("mol");
    }
    if (
      typeof body.contactName === "string" &&
      body.contactName !== currentProfile.contactName
    ) {
      changedFields.push("contactName");
    }
    if (
      typeof body.contactPhone === "string" &&
      body.contactPhone !== currentProfile.contactPhone
    ) {
      changedFields.push("contactPhone");
    }
  }

  if (changedFields.length === 0) {
    // No-op. Return the current state without writing. We deliberately do
    // NOT log here — a save that didn't save is not an event worth
    // recording, and CloudWatch volume matters.
    const fullName = await resolveFullName(db, user.id, user.role);
    return c.json(
      {
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          accountType: user.accountType,
          emailVerifiedAt: user.emailVerifiedAt
            ? user.emailVerifiedAt.toISOString()
            : null,
          fullName,
        },
        profile: currentProfile,
      },
      200,
    );
  }

  // ── Persist ─────────────────────────────────────────────────────────────
  // Only the changed fields go into the SET clause. Drizzle's $onUpdate
  // hook on updated_at fires for us.
  if (user.accountType === "personal") {
    const patch: Partial<typeof schema.customerProfiles.$inferInsert> = {};
    if (changedFields.includes("fullName")) patch.fullName = body.fullName!;
    if (changedFields.includes("phone")) patch.phone = body.phone!;
    await db
      .update(schema.customerProfiles)
      .set(patch)
      .where(eq(schema.customerProfiles.userId, user.id));
  } else {
    const patch: Partial<typeof schema.corporateProfiles.$inferInsert> = {};
    if (changedFields.includes("companyName")) patch.companyName = body.companyName!;
    if (changedFields.includes("vatNumber")) patch.vatNumber = body.vatNumber ?? null;
    if (changedFields.includes("registeredAddress")) {
      patch.registeredAddress = body.registeredAddress!;
    }
    if (changedFields.includes("mol")) patch.mol = body.mol!;
    if (changedFields.includes("contactName")) patch.contactName = body.contactName!;
    if (changedFields.includes("contactPhone")) patch.contactPhone = body.contactPhone!;
    await db
      .update(schema.corporateProfiles)
      .set(patch)
      .where(eq(schema.corporateProfiles.userId, user.id));
  }

  // ── Audit ───────────────────────────────────────────────────────────────
  // Structured log only; no PII values. The CloudWatch retention + Pino
  // PII-redaction policy keeps this GDPR Art. 30 / Art. 32 compatible.
  // Field NAMES are not personal data; field VALUES would be. We log the
  // former, never the latter.
  log?.info(
    {
      userId: user.id,
      accountType: user.accountType,
      changed: changedFields,
      ip: clientIp(c),
      ua: c.req.header("user-agent") ?? null,
    },
    "profile_updated",
  );

  // Re-read so we return the canonical post-write state (rather than
  // patching the in-memory object). One extra SELECT; trivially cheap.
  const updatedProfile = await resolveProfile(
    db,
    user.id,
    user.role,
    user.accountType,
  );
  const fullName = await resolveFullName(db, user.id, user.role);
  return c.json(
    {
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        accountType: user.accountType,
        emailVerifiedAt: user.emailVerifiedAt
          ? user.emailVerifiedAt.toISOString()
          : null,
        fullName,
      },
      profile: updatedProfile,
    },
    200,
  );
});

// /verify-email is intentionally NOT gated by requireAuth. Anyone holding the
// link can confirm the address — that IS the proof of email ownership.
authRoutes.openapi(verifyEmailRoute, async (c) => {
  const body = c.req.valid("json");
  const log = baseLogger;

  const result = await consumeSignupVerificationToken(body.token);
  if (!result) {
    throw new ApiError({
      type: "/problems/invalid-verification-token",
      title: "Invalid Verification Link",
      status: 400,
      detail:
        "This verification link is invalid or has expired. Request a new one from your account.",
    });
  }

  log?.info(
    { userId: result.userId, alreadyVerified: result.alreadyVerified },
    "email_verified",
  );

  return c.json({ ok: true } as const, 200);
});

// /resend-verification REQUIRES a session — only the account owner can
// trigger another mail to themselves.
authRoutes.use(resendVerificationRoute.path, requireAuth);
authRoutes.openapi(resendVerificationRoute, async (c) => {
  const user = c.get("user");
  if (!user) {
    throw new ApiError({
      type: "about:blank",
      title: "Unauthorized",
      status: 401,
      detail: "Authentication is required.",
    });
  }
  const log = baseLogger;

  if (user.emailVerifiedAt) {
    return c.json({ ok: true } as const, 200);
  }

  const decision = await evaluateResendRateLimit(user.id);
  if (!decision.allowed) {
    throw new ApiError({
      type: "/problems/resend-rate-limited",
      title: "Too Many Resend Requests",
      status: 429,
      detail:
        decision.reason === "hourly"
          ? "You can request another verification email in about an hour."
          : "You can request another verification email tomorrow.",
    });
  }

  const fullName = await resolveFullName(getDb(), user.id, user.role);

  const issued = await issueSignupVerificationToken({ userId: user.id });
  await sendSignupVerificationEmail({
    to: user.email,
    token: issued.token,
    fullName,
    logger: log,
  });

  return c.json({ ok: true } as const, 200);
});

// /forgot-password is intentionally unauthenticated — the user has FORGOTTEN
// their password, so requireAuth is impossible. Enumeration resistance lives
// inside the handler: every code path returns the same 200, always.
authRoutes.openapi(forgotPasswordRoute, async (c) => {
  const body = c.req.valid("json");
  const db = getDb();
  const log = baseLogger;

  const [user] = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      role: schema.users.role,
    })
    .from(schema.users)
    .where(
      and(eq(schema.users.email, body.email), isNull(schema.users.deletedAt)),
    )
    .limit(1);

  if (!user) {
    // Unknown email. Do nothing visible. We deliberately do NOT add a
    // sleep-to-match here — Argon2 (~50ms) and SES API call (~100ms) dominate
    // the timing variance, so a fake delay would have to be variable, which
    // gives no real signal. Document the limitation: a determined attacker
    // can probably distinguish via timing on a quiet endpoint, but combined
    // with WAF rate-limiting and the per-email cap below for known users, the
    // information value is very low.
    log?.info({ outcome: "unknown_email" }, "forgot_password");
    return c.json({ ok: true } as const, 200);
  }

  const decision = await evaluateForgotPasswordRateLimit(user.id);
  if (!decision.allowed) {
    // Internal rate limit hit. Same response — the caller MUST NOT learn
    // that this email is registered AND being hammered.
    log?.warn(
      { userId: user.id, reason: decision.reason },
      "forgot_password_rate_limited",
    );
    return c.json({ ok: true } as const, 200);
  }

  const fullName = await resolveFullName(db, user.id, user.role);

  try {
    const issued = await issueResetToken({ userId: user.id });
    await sendPasswordResetEmail({
      to: user.email,
      token: issued.token,
      fullName,
      logger: log,
    });
  } catch (err) {
    log?.error({ err, userId: user.id }, "forgot_password_issue_failed");
  }

  return c.json({ ok: true } as const, 200);
});

// /reset-password/check is the read-only "is this link still good?" probe
// the reset page fires on mount. Returns 200 for live tokens, the SAME
// generic 400/invalid-reset-token as the consume endpoint for any failure
// state (unknown / expired / consumed / user deleted) — the page renders
// the same dead-link UI in every failure case, no enumeration of why.
authRoutes.openapi(checkResetTokenRoute, async (c) => {
  const body = c.req.valid("json");
  const valid = await validateResetToken(body.token);
  if (!valid) {
    throw new ApiError({
      type: "/problems/invalid-reset-token",
      title: "Invalid Reset Link",
      status: 400,
      detail:
        "This reset link is invalid or has expired. Request a new one from the forgot-password page.",
    });
  }
  return c.json({ valid: true } as const, 200);
});

// /reset-password is intentionally unauthenticated — the token IS the proof
// of identity. The user clicking from the email link is by definition not
// logged in (or, if they are, on an unrelated device); requiring a session
// would defeat the recovery purpose.
authRoutes.openapi(resetPasswordRoute, async (c) => {
  const body = c.req.valid("json");
  const log = baseLogger;

  // HIBP check before we touch the token. Doing it first means a user who
  // picks a breached new password gets a clear 400 with field-level guidance
  // WITHOUT us consuming (and invalidating) their reset token. They can
  // pick a different password and retry with the same link.
  await guardAgainstBreachedPassword(body.newPassword, "newPassword", log);

  const result = await consumeResetToken({
    rawToken: body.token,
    newPassword: body.newPassword,
  });
  if (!result) {
    throw new ApiError({
      type: "/problems/invalid-reset-token",
      title: "Invalid Reset Link",
      status: 400,
      detail:
        "This reset link is invalid or has expired. Request a new one from the forgot-password page.",
    });
  }

  // Best-effort notification. Failure to send the "your password was changed"
  // email must NOT roll back the actual reset — the user has just lost
  // access and recovering is the whole point. Log loudly instead.
  const db = getDb();
  // Re-resolve the full name post-rotation (cheap; one row by PK).
  const [profile] = await db
    .select({
      fullName: schema.customerProfiles.fullName,
    })
    .from(schema.customerProfiles)
    .where(eq(schema.customerProfiles.userId, result.userId))
    .limit(1);
  const fullName = profile?.fullName ?? null;

  await sendPasswordChangedNotification({
    to: result.email,
    fullName,
    changedAt: new Date(),
    logger: log,
  });

  log?.info({ userId: result.userId }, "password_reset_completed");
  return c.json({ ok: true } as const, 200);
});

// /auth/change-password — the authenticated self-service rotation path.
//
// Design notes worth keeping after the obvious fact that "users can change
// their own password":
//
//   1. **Session required.** requireAuth gates this — there is no anonymous
//      change-password mode. The unauthenticated counterpart is
//      /auth/reset-password, which is gated by a one-time email token.
//
//   2. **Current password is mandatory re-auth proof.** The classic OWASP
//      Authentication Cheat Sheet threat: user logs in on a shared laptop,
//      walks away, attacker takes over the open tab. Without the
//      current-password check, the attacker can take over the account
//      permanently. Verifying the current password keeps a session-only
//      compromise transient.
//
//   3. **Constant-time verify + per-email lockout, same as /login.** If a
//      session is stolen, the attacker can iterate currentPassword guesses
//      here. We use the same `recordAttempt` machinery as /login so the
//      shared 5-fails-in-15-minutes counter applies. The 429 response uses
//      the existing `/problems/account-locked` type — the frontend treats
//      it identically to the login-locked case.
//
//   4. **HIBP-screen BEFORE the password verify.** Same ordering as
//      /reset-password: a breached new password gets rejected without
//      burning a verify-attempt against the lockout counter (which is the
//      one we actually care about preserving). If the user picked a bad
//      new password we want them to fix that without making them re-enter
//      their current password under lockout pressure.
//
//   5. **Same-password rejection.** Cheap UX nudge: refuse newPassword ===
//      currentPassword with a distinct problem type so the UI can render
//      "your new password must differ" instead of confusing the user with
//      a silent 200 on an effective no-op. This is NOT a security control
//      — Argon2id rotates the salt on every hash, so even literal-equal
//      passwords land on different hashes — it's purely a guard against
//      the most common mis-fill of the form.
//
//   6. **Drop other sessions, KEEP this one.** Industry convention. The
//      device that initiated the change is, by definition, trusted at
//      this moment (current-password proven), so logging it out would be
//      pure user-hostile churn. Every OTHER session — phone-from-last-
//      week, public-computer-forgotten-logout — gets revoked. The
//      `deleteAllSessionsForUser(userId, keepIdHash)` helper has been
//      sitting in lib/sessions.ts since the auth slice waiting for this.
//
//   7. **Best-effort notification email.** Same template as the
//      reset-password notification — gives a victim of session theft real-
//      time visibility that their password was changed and a "wasn't me,
//      reset now" runbook. Failure to send must NOT roll back the
//      rotation: the user just typed a new password successfully; tearing
//      that down because SES is having a bad day would orphan them.
authRoutes.use(changePasswordRoute.path, requireAuth);
authRoutes.openapi(changePasswordRoute, async (c) => {
  const body = c.req.valid("json");
  const user = c.get("user");
  const session = c.get("session");
  if (!user || !session) {
    throw new ApiError({
      type: "about:blank",
      title: "Unauthorized",
      status: 401,
      detail: "Authentication is required.",
    });
  }
  const log = baseLogger;
  const db = getDb();

  // (4) HIBP first — fail-open inside the guard helper.
  await guardAgainstBreachedPassword(body.newPassword, "newPassword", log);

  // (5) Cheap structural rejection BEFORE we hit the hasher / DB. We don't
  // verify the current password yet — that comparison happens in constant
  // time below. Comparing the plaintexts directly here is fine: the user
  // typed both into this same request, and rejecting an obvious no-op
  // request early avoids issuing a hash + a DB query for no reason.
  if (body.newPassword === body.currentPassword) {
    throw new ApiError({
      type: "/problems/same-password",
      title: "Bad Request",
      status: 400,
      detail: "Your new password must be different from your current password.",
      errors: [
        {
          path: "newPassword",
          message:
            "Your new password must be different from your current password.",
        },
      ],
    });
  }

  // (3) Lockout pre-check — same per-email counter as /auth/login.
  const lockout = await getLockoutState(user.email);
  if (lockout.locked) {
    throw new ApiError({
      type: "/problems/account-locked",
      title: "Too Many Attempts",
      status: 429,
      detail: lockout.unlockAt
        ? `Account temporarily locked. Try again after ${lockout.unlockAt.toISOString()}.`
        : "Account temporarily locked due to too many failed attempts.",
    });
  }

  // (3) Constant-time current-password verify. We pull the stored hash by
  // user.id (not email) because the session is the authoritative identity
  // here — even if the row went missing between session validation and now
  // we still go through verifyPassword with DUMMY_PASSWORD_HASH to keep
  // timing flat. recordAttempt fires whether the row exists or not.
  const [row] = await db
    .select({ passwordHash: schema.users.passwordHash })
    .from(schema.users)
    .where(eq(schema.users.id, user.id))
    .limit(1);
  const targetHash = row?.passwordHash ?? (await DUMMY_PASSWORD_HASH);
  const ok = await verifyPassword(targetHash, body.currentPassword);

  const ip = clientIp(c);
  const ua = c.req.header("user-agent") ?? null;
  const isRealSuccess = ok && !!row;
  await recordAttempt({
    email: user.email,
    success: isRealSuccess,
    ipAddress: ip,
    userAgent: ua,
  });

  if (!isRealSuccess) {
    throw new ApiError({
      type: "about:blank",
      title: "Unauthorized",
      status: 401,
      detail: "Current password is incorrect.",
    });
  }

  // (6) Rotate the hash. Argon2id at the configured params; ~50ms.
  const newPasswordHash = await hashPassword(body.newPassword);
  await db
    .update(schema.users)
    .set({ passwordHash: newPasswordHash })
    .where(eq(schema.users.id, user.id));

  // (6) Drop every session EXCEPT this one. `session.idHash` is the SHA-256
  // of the cookie the caller already has — it survives, every other device
  // signs out.
  await deleteAllSessionsForUser(user.id, session.idHash);

  // (7) Best-effort notification — same template as the reset-password
  // post-action notice. Don't await-throw: a flaky SES must not roll back
  // a successful password change.
  const [profile] = await db
    .select({ fullName: schema.customerProfiles.fullName })
    .from(schema.customerProfiles)
    .where(eq(schema.customerProfiles.userId, user.id))
    .limit(1);
  const fullName = profile?.fullName ?? null;

  await sendPasswordChangedNotification({
    to: user.email,
    fullName,
    changedAt: new Date(),
    logger: log,
  });

  log?.info({ userId: user.id }, "password_change_completed");
  return c.json({ ok: true } as const, 200);
});

// /email-change/request REQUIRES a session — only the account owner can
// initiate an email change on themselves. Additionally requires the current
// password as re-auth proof: a stolen session alone must not be enough to
// pivot to a permanent account takeover.
authRoutes.use(emailChangeRequestRoute.path, requireAuth);
authRoutes.openapi(emailChangeRequestRoute, async (c) => {
  const body = c.req.valid("json");
  const user = c.get("user");
  if (!user) {
    throw new ApiError({
      type: "about:blank",
      title: "Unauthorized",
      status: 401,
      detail: "Authentication is required.",
    });
  }
  const log = baseLogger;
  const db = getDb();

  // Re-auth: verify the current password. Same 401 shape as login on
  // failure — a stolen cookie holder must not be able to learn from the
  // response that their session is otherwise valid but the password is
  // wrong (and vice versa).
  const [row] = await db
    .select({ passwordHash: schema.users.passwordHash })
    .from(schema.users)
    .where(eq(schema.users.id, user.id))
    .limit(1);
  if (!row) {
    throw new ApiError({
      type: "about:blank",
      title: "Unauthorized",
      status: 401,
      detail: "Authentication is required.",
    });
  }
  const passwordOk = await verifyPassword(row.passwordHash, body.currentPassword);
  if (!passwordOk) {
    throw new ApiError({
      type: "about:blank",
      title: "Unauthorized",
      status: 401,
      detail: "Current password is incorrect.",
    });
  }

  // The user is authenticated and knows their own email. We can safely
  // reject a request to "change to my current email" as a 400 — no
  // enumeration is possible here because there's nothing to learn from
  // the response. Reject early with a clear validation problem so the UI
  // can surface field-level guidance.
  if (body.newEmail === user.email) {
    // Standard validation 400 (type: "about:blank" + errors[]). The frontend
    // classifies any 400 with errors as kind:"validation" and renders the
    // field-level message inline against the input.
    throw badRequest("New email must differ from your current address.", [
      {
        path: "newEmail",
        message: "New email must differ from your current address.",
      },
    ]);
  }

  // Conflict check — is the new address already used by another active
  // user? If so, silently 200 (enumeration resistance: an authenticated
  // attacker could otherwise probe addresses on this endpoint as readily
  // as on /auth/login). The user simply won't get a verify email. The
  // legitimate owner of the proposed address is unaffected — no mail is
  // sent to them.
  const [conflict] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(
      and(eq(schema.users.email, body.newEmail), isNull(schema.users.deletedAt)),
    )
    .limit(1);
  if (conflict && conflict.id !== user.id) {
    log?.info(
      { userId: user.id, outcome: "conflict" },
      "email_change_request",
    );
    return c.json({ ok: true } as const, 200);
  }

  const decision = await evaluateEmailChangeRateLimit(user.id);
  if (!decision.allowed) {
    log?.warn(
      { userId: user.id, reason: decision.reason },
      "email_change_request_rate_limited",
    );
    return c.json({ ok: true } as const, 200);
  }

  const fullName = await resolveFullName(db, user.id, user.role);

  try {
    const issued = await issueEmailChangeToken({
      userId: user.id,
      newEmail: body.newEmail,
    });
    const requestedAt = new Date();
    // Two best-effort sends in parallel — neither failure blocks the
    // other, and neither failure surfaces to the caller (the same
    // enumeration-resistant 200 shape covers it).
    await Promise.allSettled([
      sendEmailChangeVerifyEmail({
        to: body.newEmail,
        token: issued.token,
        fullName,
        logger: log,
      }),
      sendEmailChangeAlertEmail({
        to: user.email,
        newEmail: body.newEmail,
        fullName,
        requestedAt,
        logger: log,
      }),
    ]);
  } catch (err) {
    log?.error({ err, userId: user.id }, "email_change_issue_failed");
  }

  return c.json({ ok: true } as const, 200);
});

// /email-change/verify/check is the read-only "is this link still good?"
// probe the verify page fires on mount. Returns 200 + the destination
// address on live tokens; the SAME generic 400/invalid-email-change-token
// for any failure state — same posture as reset-password/check.
authRoutes.openapi(checkEmailChangeTokenRoute, async (c) => {
  const body = c.req.valid("json");
  const result = await validateEmailChangeToken(body.token);
  if (!result) {
    throw new ApiError({
      type: "/problems/invalid-email-change-token",
      title: "Invalid Email-Change Link",
      status: 400,
      detail:
        "This email-change link is invalid or has expired. Request a new one from your account.",
    });
  }
  return c.json({ valid: true, newEmail: result.newEmail } as const, 200);
});

// /email-change/verify is intentionally unauthenticated — the token IS the
// proof of control of the NEW mailbox. The user clicking from the email
// link may be on a device that has never logged in (a phone after
// requesting from a desktop, for example). Same posture as reset-password.
authRoutes.openapi(verifyEmailChangeRoute, async (c) => {
  const body = c.req.valid("json");
  const log = baseLogger;

  const result = await consumeEmailChangeToken(body.token);
  if (!result) {
    throw new ApiError({
      type: "/problems/invalid-email-change-token",
      title: "Invalid Email-Change Link",
      status: 400,
      detail:
        "This email-change link is invalid or has expired. Request a new one from your account.",
    });
  }

  // Best-effort notification. Failure to send the post-action email must
  // NOT roll back the rotation — the user has just confirmed a new
  // mailbox; reverting would orphan them.
  const db = getDb();
  const [profile] = await db
    .select({ fullName: schema.customerProfiles.fullName })
    .from(schema.customerProfiles)
    .where(eq(schema.customerProfiles.userId, result.userId))
    .limit(1);
  const fullName = profile?.fullName ?? null;

  await sendEmailChangedNotification({
    to: result.oldEmail,
    newEmail: result.newEmail,
    fullName,
    changedAt: new Date(),
    logger: log,
  });

  log?.info(
    { userId: result.userId },
    "email_change_completed",
  );
  return c.json({ ok: true } as const, 200);
});

// ─── Helpers ───────────────────────────────────────────────────────────────

async function resolveFullName(
  db: DbClient,
  userId: string,
  role: "admin" | "customer",
): Promise<string | null> {
  if (role === "admin") return null;

  const [customer] = await db
    .select({ fullName: schema.customerProfiles.fullName })
    .from(schema.customerProfiles)
    .where(eq(schema.customerProfiles.userId, userId))
    .limit(1);
  if (customer) return customer.fullName;

  const [corporate] = await db
    .select({ contactName: schema.corporateProfiles.contactName })
    .from(schema.corporateProfiles)
    .where(eq(schema.corporateProfiles.userId, userId))
    .limit(1);
  if (corporate) return corporate.contactName;

  return null;
}

/**
 * Read the editable profile for a customer. Returns null for admins (who
 * don't have one) and for customers whose profile row is missing (a schema
 * invariant violation — registration inserts one transactionally, so this
 * should be unreachable in production data).
 *
 * Shape matches the ProfileSchema discriminated union; the PATCH /auth/me
 * handler relies on `kind` to know which fields to compare and update.
 */
type ResolvedProfile =
  | {
      kind: "personal";
      fullName: string;
      phone: string;
    }
  | {
      kind: "corporate";
      companyName: string;
      eik: string;
      vatNumber: string | null;
      registeredAddress: string;
      mol: string;
      contactName: string;
      contactPhone: string;
    };

async function resolveProfile(
  db: DbClient,
  userId: string,
  role: "admin" | "customer",
  accountType: "personal" | "corporate" | null,
): Promise<ResolvedProfile | null> {
  if (role !== "customer" || !accountType) return null;

  if (accountType === "personal") {
    const [row] = await db
      .select({
        fullName: schema.customerProfiles.fullName,
        phone: schema.customerProfiles.phone,
      })
      .from(schema.customerProfiles)
      .where(eq(schema.customerProfiles.userId, userId))
      .limit(1);
    if (!row) return null;
    return { kind: "personal", fullName: row.fullName, phone: row.phone };
  }

  const [row] = await db
    .select({
      companyName: schema.corporateProfiles.companyName,
      eik: schema.corporateProfiles.eik,
      vatNumber: schema.corporateProfiles.vatNumber,
      registeredAddress: schema.corporateProfiles.registeredAddress,
      mol: schema.corporateProfiles.mol,
      contactName: schema.corporateProfiles.contactName,
      contactPhone: schema.corporateProfiles.contactPhone,
    })
    .from(schema.corporateProfiles)
    .where(eq(schema.corporateProfiles.userId, userId))
    .limit(1);
  if (!row) return null;
  return {
    kind: "corporate",
    companyName: row.companyName,
    eik: row.eik,
    vatNumber: row.vatNumber,
    registeredAddress: row.registeredAddress,
    mol: row.mol,
    contactName: row.contactName,
    contactPhone: row.contactPhone,
  };
}

function clientIp(c: Context): string | null {
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return null;
}
