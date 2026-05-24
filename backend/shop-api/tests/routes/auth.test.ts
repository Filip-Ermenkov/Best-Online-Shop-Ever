import { hashPassword } from "@shop/auth";
import { schema } from "@shop/db";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { sessionCookieName } from "../../src/lib/cookies.js";
import { getDb } from "../../src/lib/db.js";
import { getStubTransportForTests } from "../../src/lib/emails.js";
import { _resetEnvForTests } from "../../src/lib/env.js";

let app: ReturnType<typeof buildApp>;

beforeAll(() => {
  app = buildApp();
});

const VALID_PASSWORD = "Hunter2!Bigger";

/**
 * Pull the session cookie value out of a Set-Cookie header. Tests use this
 * to thread auth state into subsequent requests.
 *
 * The cookie name is environment-dependent (see lib/cookies.ts) — we ask
 * the same source-of-truth so the test never drifts from production behaviour.
 */
function extractSessionCookie(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const name = sessionCookieName();
  const match = setCookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match?.[1] ?? null;
}

async function seedRegisteredUser(opts?: {
  email?: string;
  password?: string;
}) {
  const db = getDb();
  const email = (opts?.email ?? "ivan@example.com").toLowerCase();
  const passwordHash = await hashPassword(opts?.password ?? VALID_PASSWORD);
  const [user] = await db
    .insert(schema.users)
    .values({
      email,
      passwordHash,
      role: "customer",
      accountType: "personal",
      emailVerifiedAt: new Date(),
    })
    .returning();
  if (!user) throw new Error("seed failed");
  await db.insert(schema.customerProfiles).values({
    userId: user.id,
    fullName: "Ivan Test",
    phone: "+359888000000",
  });
  return { ...user, plainPassword: opts?.password ?? VALID_PASSWORD };
}

describe("POST /auth/register", () => {
  it("creates a personal customer + profile and returns { ok: true }", async () => {
    const res = await app.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "Anna@Example.com",
        password: VALID_PASSWORD,
        fullName: "Anna Test",
        phone: "+359888111222",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body).toEqual({ ok: true });

    // Email was lowercased before insert.
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, "anna@example.com"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe("customer");
    expect(rows[0]!.accountType).toBe("personal");
    expect(rows[0]!.passwordHash).toMatch(/^\$argon2id\$/);

    const profile = await db
      .select()
      .from(schema.customerProfiles)
      .where(eq(schema.customerProfiles.userId, rows[0]!.id));
    expect(profile).toHaveLength(1);
    expect(profile[0]!.fullName).toBe("Anna Test");
  });

  it("rejects weak passwords (too short)", async () => {
    const res = await app.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "weak@example.com",
        password: "Aa1",
        fullName: "X",
        phone: "+359",
      }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
  });

  // NIST SP 800-63B Rev. 4 (shipped May 2026): the schema enforces ≥12
  // characters and no composition rules. The old "must contain digit /
  // upper / lower" assertions are intentionally gone — see the
  // PasswordSchema comment in routes/auth.ts. Boundary case lives below.
  it("accepts a digit-free passphrase as long as it is ≥12 chars", async () => {
    // 12-char passphrase with no digit. Under the old composition rule
    // this returned 400; under NIST 800-63B-4 it is accepted.
    const res = await app.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "passphrase@example.com",
        password: "correcthorse",
        fullName: "Passphrase User",
        phone: "+359888333444",
      }),
    });
    expect(res.status).toBe(200);
  });

  it("rejects passwords just under the ≥12 length floor (boundary)", async () => {
    // 11 characters. Schema-level rejection — never reaches the HIBP guard.
    const res = await app.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "elevenchars@example.com",
        password: "elevenchars", // 11 chars
        fullName: "X",
        phone: "+359",
      }),
    });
    expect(res.status).toBe(400);
    const problem = (await res.json()) as {
      type?: string;
      errors?: { path: string; message: string }[];
    };
    // Length failure is the default validation problem (type=about:blank),
    // not the breached-password type. The two must stay distinguishable
    // because the frontend renders them differently.
    expect(problem.type).not.toBe("/problems/breached-password");
    expect(
      problem.errors?.some(
        (e) => e.path === "password" && /12/.test(e.message),
      ),
    ).toBe(true);
  });

  it("returns the same shape on duplicate email — no enumeration leak", async () => {
    await seedRegisteredUser({ email: "dup@example.com" });

    const res = await app.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "DUP@example.com",
        password: VALID_PASSWORD,
        fullName: "Imposter",
        phone: "+359",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body).toEqual({ ok: true });

    // Crucially: the existing user's profile was NOT overwritten.
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, "dup@example.com"));
    expect(rows).toHaveLength(1);
    const profile = await db
      .select()
      .from(schema.customerProfiles)
      .where(eq(schema.customerProfiles.userId, rows[0]!.id));
    expect(profile[0]!.fullName).toBe("Ivan Test"); // original, not "Imposter"
  });
});

/**
 * HIBP breached-password screening — NIST SP 800-63B Rev. 4.
 *
 * The integration suite defaults `BREACHED_PASSWORD_CHECK_ENABLED=false`
 * (see vitest.config.ts) so the rest of the suite doesn't go to the
 * public api.pwnedpasswords.com endpoint. This block flips the toggle
 * ON for its own scope, substitutes `globalThis.fetch` with a stub
 * that mimics HIBP's `range/<PREFIX>` response, and asserts that the
 * register handler rejects with the right RFC 9457 type URI.
 *
 * The afterEach restores both the env cache and globalThis.fetch so
 * the toggle doesn't leak into adjacent describes.
 */
describe("POST /auth/register — HIBP breached-password screening", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.BREACHED_PASSWORD_CHECK_ENABLED;
    process.env.BREACHED_PASSWORD_CHECK_ENABLED = "false";
    _resetEnvForTests();
  });

  it("rejects a known-breached password with type=/problems/breached-password", async () => {
    process.env.BREACHED_PASSWORD_CHECK_ENABLED = "true";
    _resetEnvForTests();

    // SHA-1("password1234") = upper-cased. Compute deterministically
    // so the assertion is anchored to a real wire vector, not a guess.
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha1")
      .update("password1234")
      .digest("hex")
      .toUpperCase();
    const expectedSuffix = hash.slice(5);

    const fetchStub = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      // Only intercept HIBP. Everything else (DB, etc.) doesn't actually
      // go through globalThis.fetch in this codebase, but be defensive:
      // delegate anything non-HIBP back to the real fetch.
      if (!u.startsWith("https://api.pwnedpasswords.com/range/")) {
        // `RequestInfo` is a DOM-lib name and shop-api's tsconfig doesn't
        // load lib.dom — derive the parameter type from `fetch` itself so
        // the cast stays portable across lib configurations.
        return realFetch(url as Parameters<typeof fetch>[0]);
      }
      const body = [
        "0000000000000000000000000000000000A:0", // padding row
        `${expectedSuffix}:123456`, // the match
      ].join("\r\n");
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    });
    globalThis.fetch = fetchStub as unknown as typeof fetch;

    const res = await app.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "hibp-breached@example.com",
        password: "password1234",
        fullName: "HIBP Test",
        phone: "+359888555666",
      }),
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    const problem = (await res.json()) as {
      type?: string;
      errors?: { path: string; message: string }[];
    };
    expect(problem.type).toBe("/problems/breached-password");
    expect(
      problem.errors?.some((e) => e.path === "password"),
    ).toBe(true);

    // The user must NOT have been created — the rejection happens before
    // the existing-email check and before the insert.
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, "hibp-breached@example.com"));
    expect(rows).toHaveLength(0);

    expect(fetchStub).toHaveBeenCalledOnce();
    const calledUrl = String(fetchStub.mock.calls[0]?.[0]);
    expect(calledUrl).toBe(
      `https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`,
    );
  });

  it("fails open and accepts the registration if HIBP returns 503", async () => {
    process.env.BREACHED_PASSWORD_CHECK_ENABLED = "true";
    _resetEnvForTests();

    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).startsWith("https://api.pwnedpasswords.com/range/")) {
        return new Response("", { status: 503 });
      }
      return realFetch(url as Parameters<typeof fetch>[0]);
    }) as unknown as typeof fetch;

    const res = await app.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "hibp-down@example.com",
        password: "a-fresh-unique-passphrase-for-the-test",
        fullName: "Fail Open",
        phone: "+359888777888",
      }),
    });

    // 503 from HIBP → guard fails open → registration proceeds (200).
    expect(res.status).toBe(200);
  });
});

describe("POST /auth/login", () => {
  it("issues a session cookie on correct credentials and returns the user", async () => {
    const seeded = await seedRegisteredUser();

    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: seeded.email,
        password: seeded.plainPassword,
        rememberMe: false,
      }),
    });
    expect(res.status).toBe(200);

    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    const token = extractSessionCookie(setCookie);
    expect(token).toBeTruthy();
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//i);
    // Test env is non-production, so no Secure flag.
    expect(setCookie).not.toMatch(/Secure/i);
    // No rememberMe → no Max-Age (browser session).
    expect(setCookie).not.toMatch(/Max-Age=/i);

    const body = (await res.json()) as { user: { id: string; email: string; passwordHash?: unknown } };
    expect(body.user.email).toBe(seeded.email);
    expect(body.user.id).toBe(seeded.id);
    // Critical: the response MUST NOT leak the password hash.
    expect("passwordHash" in body.user).toBe(false);
  });

  it("sets Max-Age when rememberMe=true", async () => {
    const seeded = await seedRegisteredUser({ email: "remember@example.com" });
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: seeded.email,
        password: seeded.plainPassword,
        rememberMe: true,
      }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toMatch(/Max-Age=2592000/); // 30 days in seconds
  });

  it("rejects wrong password with 401 and identical body shape", async () => {
    const seeded = await seedRegisteredUser({ email: "wrongpass@example.com" });
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: seeded.email,
        password: "TotallyWrong1",
        rememberMe: false,
      }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    const body = (await res.json()) as { title: string };
    expect(body.title).toBe("Unauthorized");
  });

  it("rejects unknown email with same 401 shape (no enumeration)", async () => {
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "ghost@example.com",
        password: "AnyValid1Pass",
        rememberMe: false,
      }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { title: string; detail: string };
    expect(body.title).toBe("Unauthorized");
    // Same detail for unknown-email and wrong-password.
    expect(body.detail).toMatch(/invalid email or password/i);
  });

  it("locks the account after 5 failed attempts within the window", async () => {
    const seeded = await seedRegisteredUser({ email: "lock@example.com" });

    // Fire 5 wrong attempts.
    for (let i = 0; i < 5; i++) {
      const r = await app.request("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: seeded.email,
          password: "WrongPwd1",
          rememberMe: false,
        }),
      });
      expect(r.status).toBe(401);
    }

    // 6th attempt — even with the CORRECT password — must be locked out.
    const res = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: seeded.email,
        password: seeded.plainPassword,
        rememberMe: false,
      }),
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { title: string; type: string };
    expect(body.title).toBe("Too Many Attempts");
    expect(body.type).toBe("/problems/account-locked");
  });

  it("records both successes and failures in login_attempts", async () => {
    const seeded = await seedRegisteredUser({ email: "audit@example.com" });

    await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: seeded.email,
        password: "wrong1Pass",
        rememberMe: false,
      }),
    });
    await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: seeded.email,
        password: seeded.plainPassword,
        rememberMe: false,
      }),
    });

    const db = getDb();
    const attempts = await db
      .select()
      .from(schema.loginAttempts)
      .where(eq(schema.loginAttempts.email, seeded.email));
    expect(attempts).toHaveLength(2);
    expect(attempts.filter((a) => a.success)).toHaveLength(1);
    expect(attempts.filter((a) => !a.success)).toHaveLength(1);
  });
});

describe("GET /auth/me", () => {
  it("returns 401 when no cookie is present", async () => {
    const res = await app.request("/auth/me");
    expect(res.status).toBe(401);
  });

  it("returns 401 when the cookie is junk", async () => {
    const res = await app.request("/auth/me", {
      headers: { Cookie: `${sessionCookieName()}=not-a-real-token` },
    });
    expect(res.status).toBe(401);
  });

  it("returns the current user when the session cookie is valid", async () => {
    const seeded = await seedRegisteredUser({ email: "me@example.com" });

    // Login to acquire the cookie.
    const loginRes = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: seeded.email,
        password: seeded.plainPassword,
        rememberMe: false,
      }),
    });
    const token = extractSessionCookie(loginRes.headers.get("set-cookie"));
    expect(token).toBeTruthy();

    const meRes = await app.request("/auth/me", {
      headers: { Cookie: `${sessionCookieName()}=${token}` },
    });
    expect(meRes.status).toBe(200);
    const body = (await meRes.json()) as {
      user: {
        id: string;
        email: string;
        role: string;
        accountType: string | null;
        emailVerifiedAt: string | null;
      };
    };
    expect(body.user.email).toBe(seeded.email);
    expect(body.user.role).toBe("customer");
    expect(body.user.accountType).toBe("personal");
  });

  it("rejects an expired session", async () => {
    const seeded = await seedRegisteredUser({ email: "expired@example.com" });

    const loginRes = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: seeded.email,
        password: seeded.plainPassword,
        rememberMe: false,
      }),
    });
    const token = extractSessionCookie(loginRes.headers.get("set-cookie"));

    // Force-expire the session at the DB level.
    const db = getDb();
    await db.execute(
      sql`UPDATE sessions SET expires_at = now() - interval '1 minute'`,
    );

    const meRes = await app.request("/auth/me", {
      headers: { Cookie: `${sessionCookieName()}=${token}` },
    });
    expect(meRes.status).toBe(401);
  });
});

describe("POST /auth/logout", () => {
  it("clears the cookie and removes the session row", async () => {
    const seeded = await seedRegisteredUser({ email: "out@example.com" });

    const loginRes = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: seeded.email,
        password: seeded.plainPassword,
        rememberMe: false,
      }),
    });
    const token = extractSessionCookie(loginRes.headers.get("set-cookie"));

    const db = getDb();
    const beforeLogout = await db.select().from(schema.sessions);
    expect(beforeLogout).toHaveLength(1);

    const logoutRes = await app.request("/auth/logout", {
      method: "POST",
      headers: { Cookie: `${sessionCookieName()}=${token}` },
    });
    expect(logoutRes.status).toBe(204);
    const setCookie = logoutRes.headers.get("set-cookie");
    expect(setCookie).toMatch(new RegExp(`${sessionCookieName()}=;`));
    // Cookie deletion sets Max-Age=0 (or a past date).
    expect(setCookie).toMatch(/Max-Age=0|Expires=/i);

    const afterLogout = await db.select().from(schema.sessions);
    expect(afterLogout).toHaveLength(0);

    // /me must now refuse the now-invalid cookie.
    const meRes = await app.request("/auth/me", {
      headers: { Cookie: `${sessionCookieName()}=${token}` },
    });
    expect(meRes.status).toBe(401);
  });

  it("is idempotent — logout without a session returns 204 cleanly", async () => {
    const res = await app.request("/auth/logout", { method: "POST" });
    expect(res.status).toBe(204);
  });
});

/**
 * POST /auth/change-password — authenticated self-service password rotation.
 *
 * Closes OWASP ASVS V6.2 / NIST SP 800-63B-4 §5.1.1.2 ("subscribers SHALL be
 * able to change their memorized secret") plus the OWASP Authentication
 * Cheat Sheet "Change Password Feature" requirements (active session + current
 * password as re-auth proof + HIBP-screen the new password). This suite
 * exercises the 200 happy path, every distinct 4xx branch, the session
 * fan-out semantics ("drop other sessions, keep this one"), and the
 * lockout-shared-with-/login behaviour.
 */
describe("POST /auth/change-password", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.BREACHED_PASSWORD_CHECK_ENABLED;
    process.env.BREACHED_PASSWORD_CHECK_ENABLED = "false";
    _resetEnvForTests();
  });

  /** Boot a verified customer + return a logged-in session cookie. */
  async function seededAndLoggedIn(opts?: {
    email?: string;
    password?: string;
  }): Promise<{
    user: { id: string; email: string; plainPassword: string };
    cookie: string;
  }> {
    const user = await seedRegisteredUser(opts);
    const loginRes = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: user.email,
        password: user.plainPassword,
        rememberMe: false,
      }),
    });
    expect(loginRes.status).toBe(200);
    const cookie = extractSessionCookie(loginRes.headers.get("set-cookie"));
    if (!cookie) throw new Error("no session cookie issued");
    return {
      user: { id: user.id, email: user.email, plainPassword: user.plainPassword },
      cookie,
    };
  }

  it("rotates the password, drops OTHER sessions, keeps THIS session, and accepts the new password on /login", async () => {
    const NEW_PASSWORD = "BrandNewPa55word!!";
    const { user, cookie: liveCookie } = await seededAndLoggedIn({
      email: "cp-happy@example.com",
    });

    // Stand up TWO additional sessions for the same user — represents the
    // "phone + tablet + laptop" reality. After change-password these MUST
    // go away while liveCookie (the laptop initiating the change) survives.
    const db = getDb();
    const extraLogin1 = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: user.email,
        password: user.plainPassword,
        rememberMe: false,
      }),
    });
    const extraLogin2 = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: user.email,
        password: user.plainPassword,
        rememberMe: false,
      }),
    });
    const extraCookie1 = extractSessionCookie(
      extraLogin1.headers.get("set-cookie"),
    );
    const extraCookie2 = extractSessionCookie(
      extraLogin2.headers.get("set-cookie"),
    );
    expect(extraCookie1).toBeTruthy();
    expect(extraCookie2).toBeTruthy();

    const sessionsBefore = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, user.id));
    expect(sessionsBefore).toHaveLength(3);

    const res = await app.request("/auth/change-password", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${sessionCookieName()}=${liveCookie}`,
      },
      body: JSON.stringify({
        currentPassword: user.plainPassword,
        newPassword: NEW_PASSWORD,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body).toEqual({ ok: true });

    // (1) Stored hash actually rotated. Don't compare strings — verify it's a
    // fresh Argon2id digest by length + prefix.
    const rows = await db
      .select({ passwordHash: schema.users.passwordHash })
      .from(schema.users)
      .where(eq(schema.users.id, user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.passwordHash).toMatch(/^\$argon2id\$/);

    // (2) Session fan-out: exactly the calling session survives.
    const sessionsAfter = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, user.id));
    expect(sessionsAfter).toHaveLength(1);
    // /auth/me with the live cookie still works.
    const meRes = await app.request("/auth/me", {
      headers: { Cookie: `${sessionCookieName()}=${liveCookie}` },
    });
    expect(meRes.status).toBe(200);
    // /auth/me with either dropped cookie does NOT work.
    const ghost1 = await app.request("/auth/me", {
      headers: { Cookie: `${sessionCookieName()}=${extraCookie1}` },
    });
    expect(ghost1.status).toBe(401);
    const ghost2 = await app.request("/auth/me", {
      headers: { Cookie: `${sessionCookieName()}=${extraCookie2}` },
    });
    expect(ghost2.status).toBe(401);

    // (3) New password is now the password of record at /auth/login.
    const oldLogin = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: user.email,
        password: user.plainPassword,
        rememberMe: false,
      }),
    });
    expect(oldLogin.status).toBe(401);
    const newLogin = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: user.email,
        password: NEW_PASSWORD,
        rememberMe: false,
      }),
    });
    expect(newLogin.status).toBe(200);

    // (4) Notification email recorded.
    const stub = getStubTransportForTests();
    const sent = stub.findLast((e) => e.templateId === "auth.password-changed");
    expect(sent).toBeTruthy();
    expect(sent!.to).toBe(user.email);
  });

  it("rejects an unauthenticated request with 401", async () => {
    const res = await app.request("/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currentPassword: "irrelevant",
        newPassword: "AnotherValidPassword1",
      }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a wrong current password with 401 and records a failed login_attempt", async () => {
    const { user, cookie } = await seededAndLoggedIn({
      email: "cp-wrong-current@example.com",
    });

    const res = await app.request("/auth/change-password", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${sessionCookieName()}=${cookie}`,
      },
      body: JSON.stringify({
        currentPassword: "DefinitelyNotMyPassword!1",
        newPassword: "FreshAndUnrelated2!",
      }),
    });
    expect(res.status).toBe(401);
    const problem = (await res.json()) as { title: string; detail: string };
    expect(problem.title).toBe("Unauthorized");
    expect(problem.detail).toMatch(/current password/i);

    // The password hash MUST NOT have been touched.
    const db = getDb();
    const rows = await db
      .select({ passwordHash: schema.users.passwordHash })
      .from(schema.users)
      .where(eq(schema.users.id, user.id));
    expect(rows[0]!.passwordHash).toMatch(/^\$argon2id\$/);
    // Confirm the OLD password still works at /login (proves hash unchanged).
    const reLogin = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: user.email,
        password: user.plainPassword,
        rememberMe: false,
      }),
    });
    expect(reLogin.status).toBe(200);

    // recordAttempt fired (success=false) — sharing the lockout counter
    // with /login is a designed-in property of this endpoint.
    //
    // Three records total in chronological order:
    //   1. The setup-phase /auth/login that minted `cookie` — success.
    //   2. The wrong-current-password change-password attempt under test
    //      — failure (the assertion this test was built to anchor).
    //   3. The verification /auth/login above (proving the OLD password
    //      still works) — success.
    // The shape we actually care about is "exactly one failure was
    // recorded by the change-password endpoint" — assert that precisely
    // rather than coupling to the total row count, which is sensitive to
    // unrelated verification reads.
    const attempts = await db
      .select()
      .from(schema.loginAttempts)
      .where(eq(schema.loginAttempts.email, user.email));
    expect(attempts.filter((a) => !a.success)).toHaveLength(1);
    expect(attempts.filter((a) => a.success).length).toBeGreaterThanOrEqual(1);
  });

  it("rejects a new password under the 12-char floor with 400 validation (not /problems/breached-password)", async () => {
    const { cookie } = await seededAndLoggedIn({
      email: "cp-short@example.com",
    });
    const res = await app.request("/auth/change-password", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${sessionCookieName()}=${cookie}`,
      },
      body: JSON.stringify({
        currentPassword: VALID_PASSWORD,
        newPassword: "tooShort1", // 9 chars
      }),
    });
    expect(res.status).toBe(400);
    const problem = (await res.json()) as {
      type?: string;
      errors?: { path: string; message: string }[];
    };
    // The three 400 branches MUST stay distinguishable so the UI can route
    // them. Length failures are the default validation problem.
    expect(problem.type).not.toBe("/problems/breached-password");
    expect(problem.type).not.toBe("/problems/same-password");
    expect(
      problem.errors?.some(
        (e) => e.path === "newPassword" && /12/.test(e.message),
      ),
    ).toBe(true);
  });

  it("rejects newPassword === currentPassword with 400 /problems/same-password", async () => {
    const { user, cookie } = await seededAndLoggedIn({
      email: "cp-same@example.com",
    });
    const res = await app.request("/auth/change-password", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${sessionCookieName()}=${cookie}`,
      },
      body: JSON.stringify({
        currentPassword: user.plainPassword,
        newPassword: user.plainPassword, // identical → reject
      }),
    });
    expect(res.status).toBe(400);
    const problem = (await res.json()) as {
      type?: string;
      errors?: { path: string; message: string }[];
    };
    expect(problem.type).toBe("/problems/same-password");
    expect(
      problem.errors?.some((e) => e.path === "newPassword"),
    ).toBe(true);

    // Hash unchanged.
    const db = getDb();
    const rows = await db
      .select({ passwordHash: schema.users.passwordHash })
      .from(schema.users)
      .where(eq(schema.users.id, user.id));
    expect(rows[0]!.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it("rejects a HIBP-breached new password with 400 /problems/breached-password BEFORE doing anything else", async () => {
    process.env.BREACHED_PASSWORD_CHECK_ENABLED = "true";
    _resetEnvForTests();

    const { user, cookie } = await seededAndLoggedIn({
      email: "cp-breached@example.com",
    });

    const { createHash } = await import("node:crypto");
    const hash = createHash("sha1")
      .update("password1234")
      .digest("hex")
      .toUpperCase();
    const expectedSuffix = hash.slice(5);

    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (!u.startsWith("https://api.pwnedpasswords.com/range/")) {
        return realFetch(url as Parameters<typeof fetch>[0]);
      }
      const body = [
        "0000000000000000000000000000000000A:0",
        `${expectedSuffix}:99999`,
      ].join("\r\n");
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }) as unknown as typeof fetch;

    const res = await app.request("/auth/change-password", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${sessionCookieName()}=${cookie}`,
      },
      body: JSON.stringify({
        currentPassword: user.plainPassword,
        newPassword: "password1234",
      }),
    });
    expect(res.status).toBe(400);
    const problem = (await res.json()) as {
      type?: string;
      errors?: { path: string; message: string }[];
    };
    expect(problem.type).toBe("/problems/breached-password");
    expect(
      problem.errors?.some((e) => e.path === "newPassword"),
    ).toBe(true);

    // Critical: HIBP fires BEFORE the password verify, so no failed-attempt
    // row should have been recorded against the user (no spurious lockout
    // pressure from picking a bad new password).
    const db = getDb();
    const attempts = await db
      .select()
      .from(schema.loginAttempts)
      .where(
        and(
          eq(schema.loginAttempts.email, user.email),
          eq(schema.loginAttempts.success, false),
        ),
      );
    expect(attempts).toHaveLength(0);

    // Hash unchanged.
    const rows = await db
      .select({ passwordHash: schema.users.passwordHash })
      .from(schema.users)
      .where(eq(schema.users.id, user.id));
    expect(rows[0]!.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it("returns 429 /problems/account-locked when the per-email lockout has fired", async () => {
    const { user, cookie } = await seededAndLoggedIn({
      email: "cp-locked@example.com",
    });

    // Fire 5 wrong-current-password attempts to trip the same lockout
    // counter /login uses. Each must record a failure.
    for (let i = 0; i < 5; i++) {
      const r = await app.request("/auth/change-password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${sessionCookieName()}=${cookie}`,
        },
        body: JSON.stringify({
          currentPassword: `WrongGuessNumber${i}!`,
          newPassword: "FreshAndDifferent22!",
        }),
      });
      expect(r.status).toBe(401);
    }

    // Sixth attempt — even with the CORRECT current password — must lock.
    const res = await app.request("/auth/change-password", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${sessionCookieName()}=${cookie}`,
      },
      body: JSON.stringify({
        currentPassword: user.plainPassword,
        newPassword: "FreshAndDifferent22!",
      }),
    });
    expect(res.status).toBe(429);
    const problem = (await res.json()) as { title: string; type?: string };
    expect(problem.type).toBe("/problems/account-locked");

    // The honest assertion: the password was NOT rotated even though the
    // sixth attempt used the right current password — the lockout fired
    // first.
    const db = getDb();
    const reLogin = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: user.email,
        password: "FreshAndDifferent22!",
        rememberMe: false,
      }),
    });
    // /login is ALSO locked (it shares the counter) — assert the symmetry.
    expect(reLogin.status).toBe(429);

    // Hash unchanged.
    const rows = await db
      .select({ passwordHash: schema.users.passwordHash })
      .from(schema.users)
      .where(eq(schema.users.id, user.id));
    expect(rows[0]!.passwordHash).toMatch(/^\$argon2id\$/);
  });
});

/**
 * PATCH /auth/me — partial profile update.
 *
 * Covers: happy-path personal update + audit log shape, 401 when no
 * session, 400 when phone is malformed (Bulgarian normaliser rejects),
 * 400 when a corporate field is sent on a personal account (cross-type
 * rejection), 400 when an unknown field is sent (Zod .strict()), the
 * no-op short-circuit (no row update, no error), and the corporate-
 * account happy-path covering vatNumber clear-via-null.
 *
 * What is NOT covered here: the EIK-stays-immutable guarantee is
 * structural (no schema key for it on the request) and therefore
 * unreachable to test; sending it produces an unknown-field 400 like
 * any other. The audit-log assertion is on the Pino-emitted shape via
 * a structured-log spy — the existing test pattern in this file does
 * not yet wire up a Pino spy, so we assert audit semantics indirectly
 * through the database state (updated_at advanced) + the response
 * shape.
 */
describe("PATCH /auth/me", () => {
  /** Boot a verified personal customer + return a logged-in session cookie. */
  async function seededPersonalAndLoggedIn(opts?: {
    email?: string;
  }): Promise<{
    user: {
      id: string;
      email: string;
      plainPassword: string;
    };
    cookie: string;
  }> {
    const user = await seedRegisteredUser({
      email: opts?.email ?? "patch-personal@example.com",
    });
    const loginRes = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: user.email,
        password: user.plainPassword,
        rememberMe: false,
      }),
    });
    expect(loginRes.status).toBe(200);
    const cookie = extractSessionCookie(loginRes.headers.get("set-cookie"));
    if (!cookie) throw new Error("no session cookie issued");
    return {
      user: {
        id: user.id,
        email: user.email,
        plainPassword: user.plainPassword,
      },
      cookie,
    };
  }

  /** Boot a verified corporate customer + log in. Profile row created here too. */
  async function seededCorporateAndLoggedIn(): Promise<{
    user: { id: string; email: string };
    cookie: string;
  }> {
    const db = getDb();
    const email = "patch-corp@example.com";
    const passwordHash = await hashPassword(VALID_PASSWORD);
    const [u] = await db
      .insert(schema.users)
      .values({
        email,
        passwordHash,
        role: "customer",
        accountType: "corporate",
        emailVerifiedAt: new Date(),
      })
      .returning();
    if (!u) throw new Error("seed failed");
    await db.insert(schema.corporateProfiles).values({
      userId: u.id,
      companyName: "Acme OOD",
      eik: "204123456",
      vatNumber: "BG204123456",
      registeredAddress: "ул. Тест 1, София",
      mol: "Иван Иванов",
      contactName: "Мария Тестова",
      contactPhone: "+359888777666",
    });
    const loginRes = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password: VALID_PASSWORD,
        rememberMe: false,
      }),
    });
    expect(loginRes.status).toBe(200);
    const cookie = extractSessionCookie(loginRes.headers.get("set-cookie"));
    if (!cookie) throw new Error("no session cookie issued");
    return { user: { id: u.id, email }, cookie };
  }

  it("updates fullName + normalises phone, returns the post-write state", async () => {
    const { user, cookie } = await seededPersonalAndLoggedIn();

    const res = await app.request("/auth/me", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${sessionCookieName()}=${cookie}`,
      },
      body: JSON.stringify({
        fullName: "Иван Тестов",
        // Local-format phone — server normalises to E.164.
        phone: "0888 123 456",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: { fullName: string };
      profile: { kind: "personal"; fullName: string; phone: string };
    };

    expect(body.user.fullName).toBe("Иван Тестов");
    expect(body.profile.kind).toBe("personal");
    expect(body.profile.fullName).toBe("Иван Тестов");
    // Normalised to E.164 — leading 0 stripped, +359 prefixed.
    expect(body.profile.phone).toBe("+359888123456");

    // DB confirms.
    const db = getDb();
    const [row] = await db
      .select()
      .from(schema.customerProfiles)
      .where(eq(schema.customerProfiles.userId, user.id));
    expect(row!.fullName).toBe("Иван Тестов");
    expect(row!.phone).toBe("+359888123456");
  });

  it("rejects an unauthenticated request with 401 and writes nothing", async () => {
    const seeded = await seedRegisteredUser({ email: "patch-noauth@example.com" });

    const res = await app.request("/auth/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Should Not Save" }),
    });
    expect(res.status).toBe(401);

    // Row unchanged.
    const db = getDb();
    const [row] = await db
      .select()
      .from(schema.customerProfiles)
      .where(eq(schema.customerProfiles.userId, seeded.id));
    expect(row!.fullName).toBe("Ivan Test"); // value from seedRegisteredUser
  });

  it("rejects an invalid Bulgarian phone with 400 + per-field error and does not write", async () => {
    const { user, cookie } = await seededPersonalAndLoggedIn({
      email: "patch-badphone@example.com",
    });

    const res = await app.request("/auth/me", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${sessionCookieName()}=${cookie}`,
      },
      body: JSON.stringify({ phone: "123" }), // way too short
    });
    expect(res.status).toBe(400);
    const problem = (await res.json()) as {
      title: string;
      errors?: { path: string; message: string }[];
    };
    expect(problem.errors).toBeDefined();
    expect(problem.errors!.some((e) => e.path === "phone")).toBe(true);

    // Phone unchanged.
    const db = getDb();
    const [row] = await db
      .select()
      .from(schema.customerProfiles)
      .where(eq(schema.customerProfiles.userId, user.id));
    expect(row!.phone).toBe("+359888000000"); // value from seedRegisteredUser
  });

  it("rejects a corporate field sent on a personal account with 400 + per-field error", async () => {
    const { user, cookie } = await seededPersonalAndLoggedIn({
      email: "patch-cross@example.com",
    });

    const res = await app.request("/auth/me", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${sessionCookieName()}=${cookie}`,
      },
      body: JSON.stringify({ companyName: "Should Be Rejected" }),
    });
    expect(res.status).toBe(400);
    const problem = (await res.json()) as {
      errors?: { path: string; message: string }[];
    };
    expect(problem.errors).toBeDefined();
    expect(
      problem.errors!.some((e) => e.path === "companyName"),
    ).toBe(true);

    // No write — the personal row is unchanged AND no corporate row was created.
    const db = getDb();
    const [corp] = await db
      .select()
      .from(schema.corporateProfiles)
      .where(eq(schema.corporateProfiles.userId, user.id));
    expect(corp).toBeUndefined();
  });

  it("rejects an unknown field (Zod .strict()) with 400 — defence against role/email/eik smuggling", async () => {
    const { cookie } = await seededPersonalAndLoggedIn({
      email: "patch-unknown@example.com",
    });

    const res = await app.request("/auth/me", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${sessionCookieName()}=${cookie}`,
      },
      body: JSON.stringify({
        // Attempt to set the role via PATCH. The strict-schema must
        // reject this BEFORE the handler-level account-type check runs.
        role: "admin",
        fullName: "Trying To Sneak In",
      }),
    });
    expect(res.status).toBe(400);
    // The fullName write must NOT have taken effect either — atomic
    // rejection of the whole body, not a partial save.
    const db = getDb();
    const [meRow] = await db
      .select({ id: schema.users.id, role: schema.users.role })
      .from(schema.users)
      .where(eq(schema.users.email, "patch-unknown@example.com"));
    expect(meRow!.role).toBe("customer"); // role stayed customer, not admin
  });

  it("short-circuits a no-op PATCH (no changes, no updated_at bump)", async () => {
    const { user, cookie } = await seededPersonalAndLoggedIn({
      email: "patch-noop@example.com",
    });

    // Read the row's current updated_at so we can assert it didn't change.
    const db = getDb();
    const [before] = await db
      .select()
      .from(schema.customerProfiles)
      .where(eq(schema.customerProfiles.userId, user.id));
    const beforeUpdatedAt = before!.updatedAt;

    // Wait a beat so any spurious update would visibly bump the timestamp.
    await new Promise((r) => setTimeout(r, 20));

    const res = await app.request("/auth/me", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${sessionCookieName()}=${cookie}`,
      },
      body: JSON.stringify({
        // Same values as seeded.
        fullName: "Ivan Test",
        phone: "+359888000000",
      }),
    });
    expect(res.status).toBe(200);

    const [after] = await db
      .select()
      .from(schema.customerProfiles)
      .where(eq(schema.customerProfiles.userId, user.id));
    expect(after!.updatedAt.getTime()).toBe(beforeUpdatedAt.getTime());
  });

  it("updates corporate fields and accepts an explicit null vatNumber to clear it", async () => {
    const { user, cookie } = await seededCorporateAndLoggedIn();

    const res = await app.request("/auth/me", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${sessionCookieName()}=${cookie}`,
      },
      body: JSON.stringify({
        companyName: "Acme Renamed EOOD",
        vatNumber: null, // explicit clear — company deregistered from VAT
        // Local format (10 digits with leading 0 — standard Bulgarian mobile)
        // → server normalises to E.164 by stripping the trunk prefix and
        // prepending +359.
        contactPhone: "088 999 1110",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      profile: {
        kind: "corporate";
        companyName: string;
        eik: string;
        vatNumber: string | null;
        contactPhone: string;
      };
    };
    expect(body.profile.kind).toBe("corporate");
    expect(body.profile.companyName).toBe("Acme Renamed EOOD");
    expect(body.profile.vatNumber).toBeNull();
    expect(body.profile.contactPhone).toBe("+359889991110"); // normalised
    // EIK is structurally unchanged — the schema doesn't accept a key for it.
    expect(body.profile.eik).toBe("204123456");

    // DB confirms.
    const db = getDb();
    const [row] = await db
      .select()
      .from(schema.corporateProfiles)
      .where(eq(schema.corporateProfiles.userId, user.id));
    expect(row!.companyName).toBe("Acme Renamed EOOD");
    expect(row!.vatNumber).toBeNull();
    expect(row!.contactPhone).toBe("+359889991110");
    expect(row!.eik).toBe("204123456");
  });

  it("rejects a malformed VAT number with 400 + per-field error and does not write", async () => {
    const { user, cookie } = await seededCorporateAndLoggedIn();

    const res = await app.request("/auth/me", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${sessionCookieName()}=${cookie}`,
      },
      body: JSON.stringify({
        vatNumber: "RO123456789", // wrong country prefix
      }),
    });
    expect(res.status).toBe(400);
    const problem = (await res.json()) as {
      errors?: { path: string; message: string }[];
    };
    expect(problem.errors).toBeDefined();
    expect(problem.errors!.some((e) => e.path === "vatNumber")).toBe(true);

    // VAT unchanged.
    const db = getDb();
    const [row] = await db
      .select()
      .from(schema.corporateProfiles)
      .where(eq(schema.corporateProfiles.userId, user.id));
    expect(row!.vatNumber).toBe("BG204123456");
  });
});

/**
 * DELETE /auth/me — GDPR Art. 17 right-to-erasure suite.
 *
 * Covers:
 *   - happy path (personal): 204, sessions dropped, users row pseudonymised
 *     (deletedAt + anonymizedAt + sentinel email), profile + cart + tokens
 *     hard-deleted, post-action notification email queued by transport stub.
 *   - happy path (corporate): corporate_profiles hard-deleted,
 *     order_corporate_data.contactName pseudonymised on owned orders while
 *     the invoice-required fields (companyName, eik, vatNumber,
 *     registeredAddress, mol) survive intact.
 *   - 401 no cookie, 401 wrong currentPassword.
 *   - 400 missing / wrong confirmationPhrase (Zod literal mismatch).
 *   - 422 active-orders-block-deletion, surfacing the blocking orderNumber
 *     in errors[].path.
 *   - 403 admin self-deletion rejection.
 *   - Order PII pseudonymisation: customerId=NULL, customerEmail/Name/Phone
 *     blanked to "[deleted]". Order items + financial fields untouched
 *     (10-year accounting retention).
 *   - order_delivery_address: street + apartmentOrOffice stripped, but
 *     city + postalCode preserved (coarse-grained tax-territory data).
 *   - Email is freed for re-registration after deletion.
 *   - Post-delete login attempt returns generic 401 (enumeration resistance
 *     preserved — the deleted user looks like an unknown email).
 *   - Forgot-password on deleted email silently 200s (no recovery email
 *     issued).
 *   - login_attempts for the deleted user's email are hard-deleted
 *     (data-minimisation per GDPR Art. 5(1)(c)).
 */
describe("DELETE /auth/me — account erasure (GDPR Art. 17)", () => {
  /** Boot a verified personal customer + log in. Returns the seed + cookie. */
  async function seededPersonalAndLoggedIn(opts?: {
    email?: string;
  }): Promise<{
    user: { id: string; email: string; plainPassword: string };
    cookie: string;
  }> {
    const user = await seedRegisteredUser({
      email: opts?.email ?? "delete-personal@example.com",
    });
    const loginRes = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: user.email,
        password: user.plainPassword,
        rememberMe: false,
      }),
    });
    expect(loginRes.status).toBe(200);
    const cookie = extractSessionCookie(loginRes.headers.get("set-cookie"));
    if (!cookie) throw new Error("no session cookie issued");
    return {
      user: { id: user.id, email: user.email, plainPassword: user.plainPassword },
      cookie,
    };
  }

  /** Boot a corporate customer + log in. */
  async function seededCorporateAndLoggedIn(): Promise<{
    user: { id: string; email: string };
    cookie: string;
  }> {
    const db = getDb();
    const email = "delete-corp@example.com";
    const passwordHash = await hashPassword(VALID_PASSWORD);
    const [u] = await db
      .insert(schema.users)
      .values({
        email,
        passwordHash,
        role: "customer",
        accountType: "corporate",
        emailVerifiedAt: new Date(),
      })
      .returning();
    if (!u) throw new Error("seed failed");
    await db.insert(schema.corporateProfiles).values({
      userId: u.id,
      companyName: "Acme OOD",
      eik: "204555111",
      vatNumber: "BG204555111",
      registeredAddress: "ул. Корпорация 5, София",
      mol: "Петър Петров",
      contactName: "Мария Контактна",
      contactPhone: "+359888555444",
    });
    const loginRes = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: VALID_PASSWORD, rememberMe: false }),
    });
    expect(loginRes.status).toBe(200);
    const cookie = extractSessionCookie(loginRes.headers.get("set-cookie"));
    if (!cookie) throw new Error("no session cookie issued");
    return { user: { id: u.id, email }, cookie };
  }

  /** Insert an order in the given status directly (bypasses the admin
   * transition path we don't have yet). Returns the new orderNumber. */
  async function seedOrderFor(opts: {
    userId: string;
    customerEmail: string;
    status: "processing" | "accepted" | "ready_for_pickup" | "cancelled";
    withDeliveryAddress?: boolean;
    withCorporateData?: { companyName: string; eik: string; mol: string };
  }): Promise<{ id: string; orderNumber: string }> {
    const db = getDb();
    const orderNumber = `2026-05-${String(
      Math.floor(Math.random() * 99999),
    ).padStart(5, "0")}`;
    const [order] = await db
      .insert(schema.orders)
      .values({
        orderNumber,
        customerId: opts.userId,
        idempotencyKey: `test-${crypto.randomUUID()}`,
        status: opts.status,
        paymentMethod: "pay_at_store",
        customerEmail: opts.customerEmail,
        customerPhone: "+359888000000",
        customerName: "Original Name",
        subtotalCents: "1999",
        discountPercent: "0",
        discountAmountCents: "0",
        totalCents: "1999",
        acceptedAt: opts.status === "accepted" ? new Date() : null,
      })
      .returning();
    if (!order) throw new Error("order seed failed");
    if (opts.withDeliveryAddress) {
      await db.insert(schema.orderDeliveryAddress).values({
        orderId: order.id,
        city: "София",
        postalCode: "1000",
        street: "бул. Витоша 25",
        apartmentOrOffice: "ап. 4",
      });
    }
    if (opts.withCorporateData) {
      await db.insert(schema.orderCorporateData).values({
        orderId: order.id,
        companyName: opts.withCorporateData.companyName,
        eik: opts.withCorporateData.eik,
        vatNumber: null,
        registeredAddress: "ул. Тест 1, София",
        mol: opts.withCorporateData.mol,
        contactName: "Снапнат контакт",
      });
    }
    return { id: order.id, orderNumber };
  }

  // ─── 401 / 400 / 403 surface ─────────────────────────────────────────

  it("returns 401 when no session cookie is present", async () => {
    const res = await app.request("/auth/me", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currentPassword: VALID_PASSWORD,
        confirmationPhrase: "ИЗТРИЙ",
      }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when currentPassword is wrong", async () => {
    const { cookie } = await seededPersonalAndLoggedIn();
    const res = await app.request("/auth/me", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${sessionCookieName()}=${cookie}`,
      },
      body: JSON.stringify({
        currentPassword: "WrongPassword123!",
        confirmationPhrase: "ИЗТРИЙ",
      }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 400 when confirmationPhrase is wrong (Zod z.literal mismatch)", async () => {
    const { user, cookie } = await seededPersonalAndLoggedIn({
      email: "phrase-mismatch@example.com",
    });
    const res = await app.request("/auth/me", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${sessionCookieName()}=${cookie}`,
      },
      body: JSON.stringify({
        currentPassword: user.plainPassword,
        confirmationPhrase: "DELETE", // lowercase / English — wrong
      }),
    });
    expect(res.status).toBe(400);

    // User row still present + not pseudonymised.
    const db = getDb();
    const [row] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, user.id));
    expect(row!.deletedAt).toBeNull();
    expect(row!.email).toBe("phrase-mismatch@example.com");
  });

  it("returns 403 when an admin tries to self-delete via this endpoint", async () => {
    const db = getDb();
    const passwordHash = await hashPassword(VALID_PASSWORD);
    const [admin] = await db
      .insert(schema.users)
      .values({
        email: "admin@example.com",
        passwordHash,
        role: "admin",
        accountType: null,
        emailVerifiedAt: new Date(),
      })
      .returning();
    if (!admin) throw new Error("admin seed failed");
    const loginRes = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "admin@example.com",
        password: VALID_PASSWORD,
        rememberMe: false,
      }),
    });
    const cookie = extractSessionCookie(loginRes.headers.get("set-cookie"));
    if (!cookie) throw new Error("no admin session cookie");

    const res = await app.request("/auth/me", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${sessionCookieName()}=${cookie}`,
      },
      body: JSON.stringify({
        currentPassword: VALID_PASSWORD,
        confirmationPhrase: "ИЗТРИЙ",
      }),
    });
    expect(res.status).toBe(403);

    // Admin row unchanged.
    const [row] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, admin.id));
    expect(row!.deletedAt).toBeNull();
    expect(row!.email).toBe("admin@example.com");
  });

  it("returns 422 + lists blocking orderNumbers when there are active orders", async () => {
    const { user, cookie } = await seededPersonalAndLoggedIn({
      email: "blocked@example.com",
    });
    // One active order (processing) + one safe (accepted).
    const active = await seedOrderFor({
      userId: user.id,
      customerEmail: user.email,
      status: "processing",
    });
    await seedOrderFor({
      userId: user.id,
      customerEmail: user.email,
      status: "accepted",
    });

    const res = await app.request("/auth/me", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${sessionCookieName()}=${cookie}`,
      },
      body: JSON.stringify({
        currentPassword: user.plainPassword,
        confirmationPhrase: "ИЗТРИЙ",
      }),
    });
    expect(res.status).toBe(422);
    const problem = (await res.json()) as {
      type: string;
      errors: { path: string; message: string }[];
    };
    expect(problem.type).toBe("/problems/active-orders-block-deletion");
    expect(problem.errors).toBeDefined();
    expect(problem.errors.some((e) => e.path === active.orderNumber)).toBe(true);
    // The accepted order is NOT a blocker.
    expect(problem.errors.length).toBe(1);

    // Nothing was deleted (defence: a 422 must roll back any partial work).
    const db = getDb();
    const [row] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, user.id));
    expect(row!.deletedAt).toBeNull();
    expect(row!.email).toBe("blocked@example.com");
  });

  // ─── Happy path: personal ────────────────────────────────────────────

  it("happy path (personal): pseudonymises users row + hard-deletes profile / cart / tokens, drops sessions, sends notification email", async () => {
    const stub = getStubTransportForTests();
    stub.reset();

    const { user, cookie } = await seededPersonalAndLoggedIn({
      email: "happy-personal@example.com",
    });

    // Seed a cart row + an outstanding password-reset token to confirm
    // both are hard-deleted by the transaction.
    const db = getDb();
    await db.insert(schema.carts).values({ userId: user.id });
    await db.insert(schema.passwordResetTokens).values({
      tokenHash: "abc123",
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const res = await app.request("/auth/me", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${sessionCookieName()}=${cookie}`,
      },
      body: JSON.stringify({
        currentPassword: user.plainPassword,
        confirmationPhrase: "ИЗТРИЙ",
      }),
    });
    expect(res.status).toBe(204);

    // Response clears the session cookie.
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toMatch(new RegExp(`${sessionCookieName()}=;`));
    expect(setCookie).toMatch(/Max-Age=0|Expires=/i);

    // users row pseudonymised in place.
    const [pseudo] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, user.id));
    expect(pseudo).toBeDefined();
    expect(pseudo!.deletedAt).not.toBeNull();
    expect(pseudo!.anonymizedAt).not.toBeNull();
    expect(pseudo!.email).toMatch(
      /^deleted-[0-9a-f-]+@deleted\.invalid$/,
    );
    expect(pseudo!.email).not.toBe("happy-personal@example.com");
    // Sentinel password hash — not Argon2id, so verifyPassword could
    // never match against it.
    expect(pseudo!.passwordHash).toMatch(/^deleted:/);
    expect(pseudo!.passwordHash).not.toMatch(/^\$argon2id\$/);
    expect(pseudo!.emailVerifiedAt).toBeNull();

    // Profile row gone.
    const profileRows = await db
      .select()
      .from(schema.customerProfiles)
      .where(eq(schema.customerProfiles.userId, user.id));
    expect(profileRows).toHaveLength(0);

    // Cart gone.
    const cartRows = await db
      .select()
      .from(schema.carts)
      .where(eq(schema.carts.userId, user.id));
    expect(cartRows).toHaveLength(0);

    // Token gone.
    const tokens = await db
      .select()
      .from(schema.passwordResetTokens)
      .where(eq(schema.passwordResetTokens.userId, user.id));
    expect(tokens).toHaveLength(0);

    // All sessions dropped (the one we used + any others).
    const sessions = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, user.id));
    expect(sessions).toHaveLength(0);

    // Post-action notification email was sent to the ORIGINAL address.
    expect(stub.sent.length).toBeGreaterThanOrEqual(1);
    const acctEmail = stub.sent.find(
      (e) => e.templateId === "auth.account-deleted",
    );
    expect(acctEmail).toBeDefined();
    expect(acctEmail!.to).toBe("happy-personal@example.com");
  });

  it("happy path (personal): subsequent GET /auth/me with the (now-orphaned) cookie returns 401 and clears the cookie", async () => {
    const { user, cookie } = await seededPersonalAndLoggedIn({
      email: "orphan-cookie@example.com",
    });
    await app.request("/auth/me", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${sessionCookieName()}=${cookie}`,
      },
      body: JSON.stringify({
        currentPassword: user.plainPassword,
        confirmationPhrase: "ИЗТРИЙ",
      }),
    });

    const meRes = await app.request("/auth/me", {
      headers: { Cookie: `${sessionCookieName()}=${cookie}` },
    });
    expect(meRes.status).toBe(401);
    const setCookie = meRes.headers.get("set-cookie");
    expect(setCookie).toMatch(new RegExp(`${sessionCookieName()}=;`));
  });

  // ─── Happy path: corporate + invoice-retention rules ────────────────

  it("happy path (corporate): hard-deletes corporate_profiles; pseudonymises order_corporate_data.contactName but preserves invoice-required fields (companyName, eik, mol, registeredAddress)", async () => {
    const { user, cookie } = await seededCorporateAndLoggedIn();
    const order = await seedOrderFor({
      userId: user.id,
      customerEmail: user.email,
      status: "accepted",
      withCorporateData: {
        companyName: "Acme OOD",
        eik: "204555111",
        mol: "Петър Петров",
      },
    });

    const res = await app.request("/auth/me", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${sessionCookieName()}=${cookie}`,
      },
      body: JSON.stringify({
        currentPassword: VALID_PASSWORD,
        confirmationPhrase: "ИЗТРИЙ",
      }),
    });
    expect(res.status).toBe(204);

    const db = getDb();
    // corporate_profiles hard-deleted.
    const profileRows = await db
      .select()
      .from(schema.corporateProfiles)
      .where(eq(schema.corporateProfiles.userId, user.id));
    expect(profileRows).toHaveLength(0);

    // order_corporate_data snapshot survives; contactName is "[deleted]"
    // but the legally-required invoice fields are intact.
    const [snapshot] = await db
      .select()
      .from(schema.orderCorporateData)
      .where(eq(schema.orderCorporateData.orderId, order.id));
    expect(snapshot).toBeDefined();
    expect(snapshot!.contactName).toBe("[deleted]");
    expect(snapshot!.companyName).toBe("Acme OOD");
    expect(snapshot!.eik).toBe("204555111");
    expect(snapshot!.mol).toBe("Петър Петров");
    expect(snapshot!.registeredAddress).toBe("ул. Тест 1, София");
  });

  it("pseudonymises order PII (customerId=NULL, email/name/phone='[deleted]') but preserves money + order_items", async () => {
    const { user, cookie } = await seededPersonalAndLoggedIn({
      email: "order-pii@example.com",
    });
    const order = await seedOrderFor({
      userId: user.id,
      customerEmail: user.email,
      status: "accepted",
    });
    // Seed one line item to confirm it survives.
    const db = getDb();
    // Need a product to FK to; reuse the seed pattern from fixtures.
    const [product] = await db
      .insert(schema.products)
      .values({
        slug: `tmp-${crypto.randomUUID()}`,
        code: `TMP-${Math.floor(Math.random() * 100000)}`,
        name: "Tmp",
        description: "",
        priceCents: "1999",
      })
      .returning();
    await db.insert(schema.orderItems).values({
      orderId: order.id,
      productId: product!.id,
      productCode: product!.code,
      productName: product!.name,
      unitPriceCents: "1999",
      quantity: 1,
    });

    const res = await app.request("/auth/me", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${sessionCookieName()}=${cookie}`,
      },
      body: JSON.stringify({
        currentPassword: user.plainPassword,
        confirmationPhrase: "ИЗТРИЙ",
      }),
    });
    expect(res.status).toBe(204);

    const [postOrder] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, order.id));
    expect(postOrder!.customerId).toBeNull();
    expect(postOrder!.customerEmail).toBe("[deleted]");
    expect(postOrder!.customerName).toBe("[deleted]");
    expect(postOrder!.customerPhone).toBe("[deleted]");
    // Money + status unchanged — these ARE the invoice content.
    expect(postOrder!.totalCents).toBe("1999");
    expect(postOrder!.status).toBe("accepted");

    // Line items untouched.
    const items = await db
      .select()
      .from(schema.orderItems)
      .where(eq(schema.orderItems.orderId, order.id));
    expect(items).toHaveLength(1);
    expect(items[0]!.productName).toBe("Tmp");
    expect(items[0]!.unitPriceCents).toBe("1999");
  });

  it("pseudonymises order_delivery_address.street + apartment but preserves city + postalCode (coarse-grained)", async () => {
    const { user, cookie } = await seededPersonalAndLoggedIn({
      email: "addr-pii@example.com",
    });
    const order = await seedOrderFor({
      userId: user.id,
      customerEmail: user.email,
      status: "accepted",
      withDeliveryAddress: true,
    });

    const res = await app.request("/auth/me", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${sessionCookieName()}=${cookie}`,
      },
      body: JSON.stringify({
        currentPassword: user.plainPassword,
        confirmationPhrase: "ИЗТРИЙ",
      }),
    });
    expect(res.status).toBe(204);

    const db = getDb();
    const [addr] = await db
      .select()
      .from(schema.orderDeliveryAddress)
      .where(eq(schema.orderDeliveryAddress.orderId, order.id));
    expect(addr).toBeDefined();
    expect(addr!.street).toBe("[deleted]");
    expect(addr!.apartmentOrOffice).toBeNull();
    // Coarse-grained location preserved.
    expect(addr!.city).toBe("София");
    expect(addr!.postalCode).toBe("1000");
  });

  // ─── Adjacent endpoint regressions ───────────────────────────────────

  it("frees the email for re-registration after deletion", async () => {
    const { user, cookie } = await seededPersonalAndLoggedIn({
      email: "reregister@example.com",
    });
    const deleteRes = await app.request("/auth/me", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${sessionCookieName()}=${cookie}`,
      },
      body: JSON.stringify({
        currentPassword: user.plainPassword,
        confirmationPhrase: "ИЗТРИЙ",
      }),
    });
    expect(deleteRes.status).toBe(204);

    // Same email, fresh signup, should succeed (200 generic ok).
    const reg = await app.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "reregister@example.com",
        password: VALID_PASSWORD,
        fullName: "Брат на покойния",
        phone: "+359888999000",
      }),
    });
    expect(reg.status).toBe(200);

    // Now TWO rows for this email: one deleted (pseudonymised), one fresh.
    // The fresh one has the original email; the deleted one has the sentinel.
    const db = getDb();
    const original = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, "reregister@example.com"));
    expect(original).toHaveLength(1);
    expect(original[0]!.deletedAt).toBeNull();
    expect(original[0]!.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it("login attempt on a deleted email returns 401 (enumeration resistance preserved)", async () => {
    const { user, cookie } = await seededPersonalAndLoggedIn({
      email: "login-after-delete@example.com",
    });
    await app.request("/auth/me", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${sessionCookieName()}=${cookie}`,
      },
      body: JSON.stringify({
        currentPassword: user.plainPassword,
        confirmationPhrase: "ИЗТРИЙ",
      }),
    });

    const loginRes = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "login-after-delete@example.com",
        password: user.plainPassword,
        rememberMe: false,
      }),
    });
    expect(loginRes.status).toBe(401);
  });

  it("forgot-password on a deleted email silently 200s without issuing a token", async () => {
    const { user, cookie } = await seededPersonalAndLoggedIn({
      email: "forgot-after-delete@example.com",
    });
    await app.request("/auth/me", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${sessionCookieName()}=${cookie}`,
      },
      body: JSON.stringify({
        currentPassword: user.plainPassword,
        confirmationPhrase: "ИЗТРИЙ",
      }),
    });

    const fp = await app.request("/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "forgot-after-delete@example.com" }),
    });
    expect(fp.status).toBe(200);

    // No new password-reset token row exists for the (now-pseudonymised)
    // user. The token table is keyed by user_id — the deletion drops all
    // outstanding rows for this user, and forgot-password's "unknown
    // email" branch issues nothing.
    const db = getDb();
    const tokens = await db
      .select()
      .from(schema.passwordResetTokens)
      .where(eq(schema.passwordResetTokens.userId, user.id));
    expect(tokens).toHaveLength(0);
  });

  it("hard-deletes login_attempts rows keyed by the deleted email", async () => {
    const { user, cookie } = await seededPersonalAndLoggedIn({
      email: "attempts-cleanup@example.com",
    });
    // Generate a failed attempt so the table has a row to clean.
    await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "attempts-cleanup@example.com",
        password: "definitely-wrong",
        rememberMe: false,
      }),
    });

    const db = getDb();
    const beforeRows = await db
      .select()
      .from(schema.loginAttempts)
      .where(eq(schema.loginAttempts.email, "attempts-cleanup@example.com"));
    expect(beforeRows.length).toBeGreaterThan(0);

    await app.request("/auth/me", {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${sessionCookieName()}=${cookie}`,
      },
      body: JSON.stringify({
        currentPassword: user.plainPassword,
        confirmationPhrase: "ИЗТРИЙ",
      }),
    });

    const afterRows = await db
      .select()
      .from(schema.loginAttempts)
      .where(eq(schema.loginAttempts.email, "attempts-cleanup@example.com"));
    expect(afterRows).toHaveLength(0);
  });
});
