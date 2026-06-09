import { DUMMY_PASSWORD_HASH, signChallenge, verifyChallenge, verifyPassword } from "@shop/auth";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { Logger } from "pino";
import {
  beginEnrolment,
  CHALLENGE_TTL_ENROLL_SEC,
  CHALLENGE_TTL_LOGIN_SEC,
  completeEnrolment,
  consumeRecoveryCode,
  findUserByEmail,
  findUserById,
  getAdminKeys,
  getAdminLockoutState,
  verifyAdminTotpCode,
} from "../../lib/admin-mfa.js";
import {
  clearSessionCookie,
  sessionCookieName,
  setSessionCookie,
} from "../../lib/cookies.js";
import { ApiError, ProblemSchema } from "../../lib/errors.js";
import { recordAttempt } from "../../lib/lockout.js";
import { logger as baseLogger } from "../../lib/logger.js";
import { createSession, deleteSession } from "../../lib/sessions.js";
import { validationHook } from "../../lib/validation-hook.js";
import { currentUser, type AuthVariables } from "../../middleware/auth.js";
import { requireAdmin } from "../../middleware/admin.js";

/**
 * Admin authentication — mandatory TOTP MFA (AAL2: password + time-based OTP).
 *
 * This is the keystone the schema was built for since 0000 (the dormant
 * mfa_enabled / mfa_secret_encrypted / mfa_recovery_codes columns) and the
 * documented prerequisite (docs/ARCHITECTURE.md §15 item 35) for the admin-api
 * surface (item 22). It lives in shop-api as a self-contained module under
 * /admin/auth — portable Hono code that can be lifted into a dedicated
 * admin-api Lambda later without change.
 *
 * Flow (two-step, so no session is ever issued before BOTH factors are proven):
 *
 *   POST /admin/auth/login          email + password → a signed challenge:
 *                                     - mfa_required        (already enrolled)
 *                                     - enrollment_required (first login)
 *   POST /admin/auth/mfa            challenge + TOTP/recovery code → session
 *   POST /admin/auth/mfa/setup      enrol challenge → secret + otpauth URI
 *   POST /admin/auth/mfa/setup/confirm  challenge + code → session + recovery codes
 *   POST /admin/auth/logout         clear session (idempotent)
 *   GET  /admin/auth/me             whoami (requireAdmin)
 *
 * Standards followed (see docs/COMPLIANCE.md): NIST SP 800-63B-4 AAL2; OWASP
 * MFA Cheat Sheet (require MFA for admins, single-use OTP, attempt limits,
 * single-use recovery codes, secure factor reset); RFC 6238 (skew window +
 * replay guard). Enumeration-resistant like the customer auth: the SAME generic
 * 401 covers unknown email / non-admin / wrong password; the admin surface is
 * never confirmable to an unauthenticated caller.
 */

type AdminAuthVariables = AuthVariables & {
  logger: Logger;
  requestId: string;
};

export const adminAuthRoutes = new OpenAPIHono<{
  Variables: AdminAuthVariables;
}>({
  defaultHook: validationHook,
});

// ─── Shared schemas ──────────────────────────────────────────────────────────

const AdminEmailSchema = z
  .string()
  .trim()
  .min(1)
  .max(320)
  .openapi({ example: "admin@shop.bg" });

const AdminPublicUserSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string(),
    role: z.literal("admin"),
    emailVerifiedAt: z.string().nullable(),
  })
  .openapi("AdminPublicUser");

interface AdminUserLike {
  id: string;
  email: string;
  emailVerifiedAt: Date | null;
}

function publicAdmin(user: AdminUserLike) {
  return {
    id: user.id,
    email: user.email,
    role: "admin" as const,
    emailVerifiedAt: user.emailVerifiedAt
      ? user.emailVerifiedAt.toISOString()
      : null,
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

/** The flat generic credential rejection. Identical for every failed branch so
 *  no oracle distinguishes unknown email / customer / wrong password. */
function invalidCredentials(): ApiError {
  return new ApiError({
    type: "about:blank",
    title: "Unauthorized",
    status: 401,
    detail: "Invalid email or password.",
  });
}

/** Generic MFA-step rejection (bad/expired challenge OR bad code). */
function invalidMfa(detail: string): ApiError {
  return new ApiError({
    type: "/problems/admin-mfa-invalid",
    title: "Verification Failed",
    status: 401,
    detail,
  });
}

function adminLocked(unlockAt: Date | null): ApiError {
  return new ApiError({
    type: "/problems/admin-account-locked",
    title: "Too Many Attempts",
    status: 429,
    detail: unlockAt
      ? `Admin login temporarily locked. Try again after ${unlockAt.toISOString()}.`
      : "Admin login temporarily locked due to too many failed attempts.",
  });
}

// ─── POST /admin/auth/login (factor 1: password) ─────────────────────────────

const AdminLoginRequestSchema = z
  .object({
    email: AdminEmailSchema,
    password: z.string().min(1).max(1024),
  })
  .openapi("AdminLoginRequest");

const AdminLoginResponseSchema = z
  .object({
    status: z.enum(["mfa_required", "enrollment_required"]),
    /** Short-lived signed token to present at the second step. */
    challenge: z.string(),
  })
  .openapi("AdminLoginResponse");

const adminLoginRoute = createRoute({
  method: "post",
  path: "/login",
  tags: ["admin-auth"],
  summary: "Admin login — verify password, return an MFA/enrolment challenge",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: AdminLoginRequestSchema } },
    },
  },
  responses: {
    200: {
      description:
        "Password accepted. No session yet — present `challenge` to /admin/auth/mfa (status=mfa_required) or enrol via /admin/auth/mfa/setup (status=enrollment_required).",
      content: { "application/json": { schema: AdminLoginResponseSchema } },
    },
    401: {
      description: "Invalid credentials. Identical body for every failure mode.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    429: {
      description: "Too many failed attempts — admin login temporarily locked.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminAuthRoutes.openapi(adminLoginRoute, async (c) => {
  const body = c.req.valid("json");
  const log = c.get("logger") ?? baseLogger;
  const email = body.email.toLowerCase();
  const keys = getAdminKeys();

  const lockout = await getAdminLockoutState(email);
  if (lockout.locked) throw adminLocked(lockout.unlockAt);

  const user = await findUserByEmail(email);
  const isAdmin = !!user && !user.deletedAt && user.role === "admin";
  // Constant-time across existence/role: verify against the dummy hash when the
  // email is unknown, deleted, or a non-admin (customer) account.
  const targetHash = isAdmin ? user!.passwordHash : await DUMMY_PASSWORD_HASH;
  const passwordOk = await verifyPassword(targetHash, body.password);

  const ip = clientIp(c);
  const ua = c.req.header("user-agent") ?? null;

  if (!passwordOk || !isAdmin || !user) {
    // Only failures are recorded at the password stage; a successful password
    // is recorded as a full success once the second factor also passes.
    await recordAttempt({ email, success: false, ipAddress: ip, userAgent: ua });
    log.warn({ ip }, "admin_login_password_failed");
    throw invalidCredentials();
  }

  if (user.mfaEnabled) {
    const challenge = signChallenge(
      { userId: user.id, purpose: "admin_mfa", ttlSeconds: CHALLENGE_TTL_LOGIN_SEC },
      keys.challengeKey,
    );
    log.info({ adminId: user.id, ip }, "admin_login_password_ok");
    return c.json({ status: "mfa_required" as const, challenge }, 200);
  }

  // Admin exists but has never enrolled TOTP — issue an enrolment-scoped
  // challenge. No full session is granted until enrolment completes.
  const challenge = signChallenge(
    { userId: user.id, purpose: "admin_mfa_enroll", ttlSeconds: CHALLENGE_TTL_ENROLL_SEC },
    keys.challengeKey,
  );
  log.info({ adminId: user.id, ip }, "admin_login_enrollment_required");
  return c.json({ status: "enrollment_required" as const, challenge }, 200);
});

// ─── POST /admin/auth/mfa (factor 2: TOTP or recovery code) ──────────────────

const AdminMfaRequestSchema = z
  .object({
    challenge: z.string().min(1),
    /** A 6-digit TOTP code, or a recovery code (XXXXX-XXXXX). */
    code: z.string().trim().min(1).max(64),
  })
  .openapi("AdminMfaRequest");

const AdminMfaResponseSchema = z
  .object({
    user: AdminPublicUserSchema,
    /** True if a single-use recovery code was redeemed instead of a TOTP code. */
    recoveryCodeUsed: z.boolean(),
    /** Recovery codes left after a redemption, else null. */
    recoveryCodesRemaining: z.number().int().nullable(),
  })
  .openapi("AdminMfaResponse");

const adminMfaRoute = createRoute({
  method: "post",
  path: "/mfa",
  tags: ["admin-auth"],
  summary: "Admin MFA — verify the TOTP/recovery code and open the session",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: AdminMfaRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Second factor accepted — sets the admin session cookie.",
      content: { "application/json": { schema: AdminMfaResponseSchema } },
    },
    401: {
      description: "Challenge expired/invalid OR the code did not verify.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    429: {
      description: "Too many failed attempts — admin login temporarily locked.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminAuthRoutes.openapi(adminMfaRoute, async (c) => {
  const body = c.req.valid("json");
  const log = c.get("logger") ?? baseLogger;
  const keys = getAdminKeys();

  const verified = verifyChallenge(body.challenge, "admin_mfa", keys.challengeKey);
  if (!verified.valid) {
    throw invalidMfa("Your verification session expired. Please sign in again.");
  }

  const user = await findUserById(verified.userId);
  if (!user || user.deletedAt || user.role !== "admin" || !user.mfaEnabled) {
    throw invalidMfa("Your verification session expired. Please sign in again.");
  }

  const lockout = await getAdminLockoutState(user.email);
  if (lockout.locked) throw adminLocked(lockout.unlockAt);

  const ip = clientIp(c);
  const ua = c.req.header("user-agent") ?? null;
  const code = body.code.trim();

  let success = false;
  let recoveryCodeUsed = false;
  let recoveryCodesRemaining: number | null = null;

  if (/^\d{6}$/.test(code)) {
    success = await verifyAdminTotpCode(user, code, keys.encKey);
  } else {
    const consumed = await consumeRecoveryCode(user.id, code);
    success = consumed.ok;
    recoveryCodeUsed = consumed.ok;
    recoveryCodesRemaining = consumed.ok ? consumed.remaining : null;
  }

  await recordAttempt({ email: user.email, success, ipAddress: ip, userAgent: ua });

  if (!success) {
    log.warn({ adminId: user.id, ip }, "admin_mfa_failed");
    throw invalidMfa("Invalid code.");
  }

  const { token } = await createSession({
    userId: user.id,
    rememberMe: false,
    role: "admin",
    ipAddress: ip,
    userAgent: ua,
  });
  setSessionCookie(c, token, { rememberMe: false });

  log.info({ adminId: user.id, ip, recoveryCodeUsed }, "admin_login_success");
  if (recoveryCodeUsed) {
    // Operational signal: a recovery code being spent is rare and worth an
    // alert (the admin lost their authenticator, or someone else has the codes).
    log.warn(
      { adminId: user.id, recoveryCodesRemaining },
      "admin_recovery_code_used",
    );
  }

  return c.json(
    {
      user: publicAdmin(user),
      recoveryCodeUsed,
      recoveryCodesRemaining,
    },
    200,
  );
});

// ─── POST /admin/auth/mfa/setup (first-time enrolment: provision) ────────────

const AdminEnrollSetupRequestSchema = z
  .object({ challenge: z.string().min(1) })
  .openapi("AdminEnrollSetupRequest");

const AdminEnrollSetupResponseSchema = z
  .object({
    /** Base32 secret — render as a QR (otpauthUri) and offer for manual entry. */
    secret: z.string(),
    otpauthUri: z.string(),
    /** Fresh enrolment challenge to present at /mfa/setup/confirm. */
    challenge: z.string(),
  })
  .openapi("AdminEnrollSetupResponse");

const adminEnrollSetupRoute = createRoute({
  method: "post",
  path: "/mfa/setup",
  tags: ["admin-auth"],
  summary: "Begin admin TOTP enrolment — provision a secret + otpauth URI",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: AdminEnrollSetupRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "A pending (not-yet-enabled) secret was stored; show the QR.",
      content: { "application/json": { schema: AdminEnrollSetupResponseSchema } },
    },
    401: {
      description: "Enrolment challenge expired/invalid.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    409: {
      description: "MFA is already enrolled for this admin.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminAuthRoutes.openapi(adminEnrollSetupRoute, async (c) => {
  const body = c.req.valid("json");
  const log = c.get("logger") ?? baseLogger;
  const keys = getAdminKeys();

  const verified = verifyChallenge(
    body.challenge,
    "admin_mfa_enroll",
    keys.challengeKey,
  );
  if (!verified.valid) {
    throw invalidMfa("Your enrolment session expired. Please sign in again.");
  }
  const user = await findUserById(verified.userId);
  if (!user || user.deletedAt || user.role !== "admin") {
    throw invalidMfa("Your enrolment session expired. Please sign in again.");
  }
  if (user.mfaEnabled) {
    throw new ApiError({
      type: "/problems/admin-mfa-already-enrolled",
      title: "Already Enrolled",
      status: 409,
      detail: "MFA is already set up for this account.",
    });
  }

  const pending = await beginEnrolment(user, keys);
  // Re-mint a fresh enrolment challenge so the confirm step has a full window.
  const challenge = signChallenge(
    { userId: user.id, purpose: "admin_mfa_enroll", ttlSeconds: CHALLENGE_TTL_ENROLL_SEC },
    keys.challengeKey,
  );
  log.info({ adminId: user.id }, "admin_mfa_enrolment_started");
  return c.json(
    { secret: pending.secretBase32, otpauthUri: pending.otpauthUri, challenge },
    200,
  );
});

// ─── POST /admin/auth/mfa/setup/confirm (enable + issue recovery codes) ──────

const AdminEnrollConfirmRequestSchema = z
  .object({
    challenge: z.string().min(1),
    code: z.string().trim().regex(/^\d{6}$/, "Expected a 6-digit code"),
  })
  .openapi("AdminEnrollConfirmRequest");

const AdminEnrollConfirmResponseSchema = z
  .object({
    user: AdminPublicUserSchema,
    /** The single-use recovery codes — shown exactly once, here. */
    recoveryCodes: z.array(z.string()),
  })
  .openapi("AdminEnrollConfirmResponse");

const adminEnrollConfirmRoute = createRoute({
  method: "post",
  path: "/mfa/setup/confirm",
  tags: ["admin-auth"],
  summary: "Confirm admin TOTP enrolment — enable MFA, open session, return recovery codes",
  request: {
    body: {
      required: true,
      content: {
        "application/json": { schema: AdminEnrollConfirmRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description:
        "MFA enabled; admin session cookie set. recoveryCodes are shown ONCE — store them now.",
      content: {
        "application/json": { schema: AdminEnrollConfirmResponseSchema },
      },
    },
    401: {
      description: "Enrolment challenge expired/invalid OR the code did not verify.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    409: {
      description: "MFA is already enrolled for this admin.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminAuthRoutes.openapi(adminEnrollConfirmRoute, async (c) => {
  const body = c.req.valid("json");
  const log = c.get("logger") ?? baseLogger;
  const keys = getAdminKeys();

  const verified = verifyChallenge(
    body.challenge,
    "admin_mfa_enroll",
    keys.challengeKey,
  );
  if (!verified.valid) {
    throw invalidMfa("Your enrolment session expired. Please sign in again.");
  }
  const user = await findUserById(verified.userId);
  if (!user || user.deletedAt || user.role !== "admin") {
    throw invalidMfa("Your enrolment session expired. Please sign in again.");
  }
  if (user.mfaEnabled) {
    throw new ApiError({
      type: "/problems/admin-mfa-already-enrolled",
      title: "Already Enrolled",
      status: 409,
      detail: "MFA is already set up for this account.",
    });
  }

  const recoveryCodes = await completeEnrolment(user, body.code.trim(), keys.encKey);
  if (!recoveryCodes) {
    log.warn({ adminId: user.id }, "admin_mfa_enrolment_code_invalid");
    throw invalidMfa("Invalid code.");
  }

  const ip = clientIp(c);
  const ua = c.req.header("user-agent") ?? null;
  const { token } = await createSession({
    userId: user.id,
    rememberMe: false,
    role: "admin",
    ipAddress: ip,
    userAgent: ua,
  });
  setSessionCookie(c, token, { rememberMe: false });
  await recordAttempt({ email: user.email, success: true, ipAddress: ip, userAgent: ua });

  log.info({ adminId: user.id, ip }, "admin_mfa_enrolled");
  return c.json({ user: publicAdmin(user), recoveryCodes }, 200);
});

// ─── POST /admin/auth/logout ─────────────────────────────────────────────────

const adminLogoutRoute = createRoute({
  method: "post",
  path: "/logout",
  tags: ["admin-auth"],
  summary: "Log out the current admin session",
  responses: {
    204: { description: "Session cleared. Idempotent." },
  },
});

adminAuthRoutes.openapi(adminLogoutRoute, async (c) => {
  const token = getCookie(c, sessionCookieName());
  if (token) await deleteSession(token);
  clearSessionCookie(c);
  return c.body(null, 204);
});

// ─── GET /admin/auth/me ──────────────────────────────────────────────────────

const AdminMeResponseSchema = z
  .object({ user: AdminPublicUserSchema })
  .openapi("AdminMeResponse");

const adminMeRoute = createRoute({
  method: "get",
  path: "/me",
  tags: ["admin-auth"],
  summary: "Return the currently authenticated admin",
  responses: {
    200: {
      description: "The admin behind the active session cookie.",
      content: { "application/json": { schema: AdminMeResponseSchema } },
    },
    404: {
      description: "No admin session (uniform with an unknown route).",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

// currentUser resolves the cookie; requireAdmin enforces role=admin (404 if not).
adminAuthRoutes.use(adminMeRoute.path, currentUser, requireAdmin);
adminAuthRoutes.openapi(adminMeRoute, async (c) => {
  const user = c.get("user")!; // requireAdmin guarantees presence + role
  return c.json({ user: publicAdmin(user) }, 200);
});
