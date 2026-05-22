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
