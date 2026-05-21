import { hashPassword } from "@shop/auth";
import { schema } from "@shop/db";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { sessionCookieName } from "../../src/lib/cookies.js";
import { getDb } from "../../src/lib/db.js";
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
        return realFetch(url as RequestInfo);
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
      return realFetch(url as RequestInfo);
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
