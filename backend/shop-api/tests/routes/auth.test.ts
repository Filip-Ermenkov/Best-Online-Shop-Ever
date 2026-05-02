import { hashPassword } from "@shop/auth";
import { schema } from "@shop/db";
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { sessionCookieName } from "../../src/lib/cookies.js";
import { getDb } from "../../src/lib/db.js";

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

  it("rejects passwords missing a digit", async () => {
    const res = await app.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "weak2@example.com",
        password: "NoDigitsHere",
        fullName: "X",
        phone: "+359",
      }),
    });
    expect(res.status).toBe(400);
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
