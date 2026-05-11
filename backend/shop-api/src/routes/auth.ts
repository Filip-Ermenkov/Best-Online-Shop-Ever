import {
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
import { ApiError, ProblemSchema, badRequest, internal } from "../lib/errors.js";
import { logger as baseLogger } from "../lib/logger.js";
import { getLockoutState, recordAttempt } from "../lib/lockout.js";
import { createSession, deleteSession } from "../lib/sessions.js";
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

const PasswordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(1024, "Password is unreasonably long")
  .refine((s) => /[a-z]/.test(s), "Password must contain a lowercase letter")
  .refine((s) => /[A-Z]/.test(s), "Password must contain an uppercase letter")
  .refine((s) => /[0-9]/.test(s), "Password must contain a digit")
  .openapi({ description: "≥8 chars, ≥1 upper, ≥1 lower, ≥1 digit." });

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
      description: "Validation error.",
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
  .object({ user: PublicUserSchema })
  .openapi("MeResponse");

const meRoute = createRoute({
  method: "get",
  path: "/me",
  tags: ["auth"],
  summary: "Return the currently authenticated user",
  responses: {
    200: {
      description: "The user behind the active session cookie.",
      content: { "application/json": { schema: MeResponseSchema } },
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
        "Token is invalid/expired/consumed, OR newPassword failed strength validation. The two cases are distinguished by `type`: /problems/invalid-reset-token vs the default validation problem with field-level errors.",
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

// ─── Router ────────────────────────────────────────────────────────────────

export const authRoutes = new OpenAPIHono<{ Variables: AuthVariables }>({
  defaultHook: validationHook,
});

authRoutes.openapi(registerRoute, async (c) => {
  const body = c.req.valid("json");
  const db = getDb();
  const log = baseLogger;

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
  const fullName = await resolveFullName(getDb(), user.id, user.role);
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

function clientIp(c: Context): string | null {
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return null;
}
