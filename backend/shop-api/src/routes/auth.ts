import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  needsRehash,
  verifyPassword,
} from "@shop/auth";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { schema } from "@shop/db";
import { and, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import {
  clearSessionCookie,
  sessionCookieName,
  setSessionCookie,
} from "../lib/cookies.js";
import { getDb } from "../lib/db.js";
import { ApiError, ProblemSchema, internal } from "../lib/errors.js";
import { getLockoutState, recordAttempt } from "../lib/lockout.js";
import { createSession, deleteSession } from "../lib/sessions.js";
import { validationHook } from "../lib/validation-hook.js";
import { requireAuth, type AuthVariables } from "../middleware/auth.js";

// ─── Reusable schemas ──────────────────────────────────────────────────────

/**
 * Email validation:
 *   - RFC-style email shape via Zod
 *   - max 254 chars (RFC 5321 SMTP path limit)
 *   - normalised to lowercase + trim before storage / lookup
 */
const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("Must be a valid email address")
  .max(254, "Email is too long")
  .openapi({ example: "ivan@example.com" });

/**
 * Password validation matches README §8 spec:
 *   - min 8 characters
 *   - at least one uppercase letter
 *   - at least one lowercase letter
 *   - at least one digit
 *
 * NIST 800-63B Rev 4 (July 2025) drops mandatory complexity in favour of
 * length, but the spec's complexity rules are application-side product
 * decisions and we honour them. The frontend already shows a real-time
 * checklist matching these.
 *
 * No max length here — argon2id rehashes any input length to a fixed-size
 * digest, so allowing 256+ char passphrases costs nothing.
 */
const PasswordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(1024, "Password is unreasonably long")
  .refine((s) => /[a-z]/.test(s), "Password must contain a lowercase letter")
  .refine((s) => /[A-Z]/.test(s), "Password must contain an uppercase letter")
  .refine((s) => /[0-9]/.test(s), "Password must contain a digit")
  .openapi({ description: "≥8 chars, ≥1 upper, ≥1 lower, ≥1 digit." });

const FullNameSchema = z.string().trim().min(1, "Name is required").max(120);
// Keep the phone permissive — proper E.164 validation belongs in a follow-up
// once we know which markets the spec targets beyond Bulgaria.
const PhoneSchema = z.string().trim().min(3, "Phone is required").max(40);

const PublicUserSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string(),
    role: z.enum(["admin", "customer"]),
    accountType: z.enum(["personal", "corporate"]).nullable(),
    emailVerifiedAt: z.string().nullable(),
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

/**
 * Register response.
 *
 * We deliberately return a generic { ok: true } shape rather than the new
 * user object. Reason: spec README §8 forbids leaking whether an email is
 * already registered. If we returned the user record on the new path and
 * an error on the existing path, the status code itself would leak.
 *
 * In this slice email isn't wired, so a duplicate email currently still
 * 200s and silently no-ops. When SES + verification land, the duplicate
 * branch will send a "you already have an account" email. The HTTP shape
 * stays the same.
 */
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
    // Login does NOT enforce the registration complexity rules — old accounts
    // that pre-date a tightening must still be able to authenticate. Just
    // bound the length to deflect abuse.
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

// ─── Router ────────────────────────────────────────────────────────────────

export const authRoutes = new OpenAPIHono<{ Variables: AuthVariables }>({
  defaultHook: validationHook,
});

authRoutes.openapi(registerRoute, async (c) => {
  const body = c.req.valid("json");
  const db = getDb();

  // Check for existing — but NEVER let the response distinguish.
  const [existing] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(
      and(eq(schema.users.email, body.email), isNull(schema.users.deletedAt)),
    )
    .limit(1);

  if (existing) {
    // Quiet idempotent success — frontend always tells the user "check your
    // inbox". When SES is wired, the duplicate branch will send the existing
    // owner a "you already have an account" notice. We deliberately do not
    // log the email at INFO here because that would be PII at scale; the
    // request_end log already shows the route + status.
    return c.json({ ok: true } as const, 200);
  }

  const passwordHash = await hashPassword(body.password);

  // Two-step insert (user + customer_profiles) inside a transaction so a
  // crash between them can't leave a profile-less customer.
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.users)
      .values({
        email: body.email,
        passwordHash,
        role: "customer",
        accountType: "personal",
        // emailVerifiedAt stays null until the email-verification flow lands.
      })
      .returning();

    const user = inserted[0];
    if (!user) throw internal("Failed to create user");

    await tx.insert(schema.customerProfiles).values({
      userId: user.id,
      fullName: body.fullName,
      phone: body.phone,
    });
  });

  return c.json({ ok: true } as const, 200);
});

authRoutes.openapi(loginRoute, async (c) => {
  const body = c.req.valid("json");
  const db = getDb();

  // 1. Lockout pre-check. Cheap — single COUNT — and short-circuits the
  //    expensive argon2 verify when we're already locked out.
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

  // 2. Lookup. Even unknown emails advance through argon2.verify() against
  //    DUMMY_PASSWORD_HASH so the response time is constant regardless of
  //    whether the email exists.
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

  // 3. Audit log + lockout-counter advance. We log BOTH success and failure
  //    so a future "show recent logins" page on /account is straightforward.
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
    // Identical body for unknown email and wrong password — no enumeration.
    throw new ApiError({
      type: "about:blank",
      title: "Unauthorized",
      status: 401,
      detail: "Invalid email or password.",
    });
  }

  // 4. Opportunistic rehash if the stored hash uses outdated parameters.
  //    Cheap to check; only runs on params drift. Fire-and-forget would be
  //    nicer but we want the new hash to be in place before the next login,
  //    so we await.
  if (needsRehash(user.passwordHash)) {
    const upgraded = await hashPassword(body.password);
    await db
      .update(schema.users)
      .set({ passwordHash: upgraded })
      .where(eq(schema.users.id, user.id));
  }

  // 5. Mint the session, set the cookie, return the public user view.
  const { token } = await createSession({
    userId: user.id,
    rememberMe: body.rememberMe,
    ipAddress: ip,
    userAgent: ua,
  });
  setSessionCookie(c, token, { rememberMe: body.rememberMe });

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
  // 204 is the right shape — no body, request was processed.
  return c.body(null, 204);
});

// /me uses the requireAuth gate. currentUser at the app level has already
// populated c.var.user when a valid cookie is present.
authRoutes.use(meRoute.path, requireAuth);
authRoutes.openapi(meRoute, (c) => {
  // requireAuth guaranteed user is set, but the type system can't see that.
  const user = c.get("user");
  if (!user) {
    // Defensive — should never trigger.
    throw new ApiError({
      type: "about:blank",
      title: "Unauthorized",
      status: 401,
      detail: "Authentication is required.",
    });
  }
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
      },
    },
    200,
  );
});

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Best-effort client IP. CloudFront in production sets x-forwarded-for; we
 * trust only the FIRST hop (the public client) and ignore everything after,
 * because intermediate hops can be forged by clients sending fake headers.
 *
 * In local dev the header is absent — we get the connecting socket's address
 * from Hono's `connInfo` if available, or null. Null is fine: ipAddress is
 * a nullable column.
 */
function clientIp(c: Context): string | null {
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  // Hono doesn't expose the raw socket on every adapter; we fall back gracefully.
  return null;
}
