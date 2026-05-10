import { hashPassword } from "@shop/auth";
import { schema } from "@shop/db";
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { sessionCookieName } from "../../src/lib/cookies.js";
import { getDb } from "../../src/lib/db.js";
import { getStubTransportForTests } from "../../src/lib/emails.js";

let app: ReturnType<typeof buildApp>;

beforeAll(() => {
  app = buildApp();
});

const VALID_PASSWORD = "Hunter2!Bigger";

/** Pull the session cookie value from a Set-Cookie header. Mirrors auth.test.ts. */
function extractSessionCookie(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const name = sessionCookieName();
  const match = setCookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match?.[1] ?? null;
}

/** Pull the `?token=...` value from the URL inside the verification email body. */
function tokenFromLastEmail(): string {
  const stub = getStubTransportForTests();
  const last = stub.findLast(() => true);
  if (!last) throw new Error("no email recorded");
  const url = stub.extractUrl(last);
  if (!url) throw new Error("no URL in email body");
  const match = url.match(/[?&]token=([^&\s]+)/);
  if (!match || !match[1]) throw new Error(`no token in URL: ${url}`);
  return decodeURIComponent(match[1]);
}

/** Seed an unverified user (emailVerifiedAt=null) WITHOUT going through the
 * register endpoint, so we control the test fixture exactly. */
async function seedUnverifiedUser(opts?: {
  email?: string;
}): Promise<{ id: string; email: string; password: string }> {
  const db = getDb();
  const email = (opts?.email ?? "uv@example.com").toLowerCase();
  const passwordHash = await hashPassword(VALID_PASSWORD);
  const [user] = await db
    .insert(schema.users)
    .values({
      email,
      passwordHash,
      role: "customer",
      accountType: "personal",
      emailVerifiedAt: null,
    })
    .returning();
  if (!user) throw new Error("seed failed");
  await db.insert(schema.customerProfiles).values({
    userId: user.id,
    fullName: "Unverified Test",
    phone: "+359888000000",
  });
  return { id: user.id, email: user.email, password: VALID_PASSWORD };
}

async function loginAndGetCookie(
  email: string,
  password: string,
): Promise<string> {
  const res = await app.request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, rememberMe: false }),
  });
  expect(res.status).toBe(200);
  const cookie = extractSessionCookie(res.headers.get("set-cookie"));
  if (!cookie) throw new Error("no session cookie issued");
  return cookie;
}

describe("POST /auth/register sends a verification email", () => {
  it("records exactly one email containing a verify URL after register", async () => {
    const res = await app.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "Boris@Example.com",
        password: VALID_PASSWORD,
        fullName: "Boris Test",
        phone: "+359888333444",
      }),
    });
    expect(res.status).toBe(200);

    const stub = getStubTransportForTests();
    expect(stub.sent).toHaveLength(1);
    const sent = stub.sent[0]!;
    expect(sent.to).toBe("boris@example.com");
    expect(sent.templateId).toBe("auth.signup-verification");
    expect(sent.subject).toBe("Потвърдете имейл адреса си");
    const url = stub.extractUrl(sent);
    expect(url).toBeTruthy();
    expect(url).toContain("/account/verify-email?token=");

    // A token row was persisted (hash, not plaintext).
    const db = getDb();
    const tokens = await db.select().from(schema.emailVerificationTokens);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.kind).toBe("signup");
    expect(tokens[0]!.consumedAt).toBeNull();
  });

  it("does NOT send a second email on duplicate-email register (silent no-op)", async () => {
    await seedUnverifiedUser({ email: "dup-no-email@example.com" });
    const res = await app.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "dup-no-email@example.com",
        password: VALID_PASSWORD,
        fullName: "Imposter",
        phone: "+359888000999",
      }),
    });
    expect(res.status).toBe(200);
    const stub = getStubTransportForTests();
    // The duplicate branch must not leak through to email — it would tell
    // an attacker the address is registered.
    expect(stub.sent).toHaveLength(0);
  });
});

describe("POST /auth/verify-email", () => {
  it("verifies a valid token, sets email_verified_at, and consumes the token", async () => {
    await app.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "ver1@example.com",
        password: VALID_PASSWORD,
        fullName: "Ver One",
        phone: "+359888100100",
      }),
    });
    const token = tokenFromLastEmail();

    const res = await app.request("/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(200);

    const db = getDb();
    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, "ver1@example.com"));
    expect(user!.emailVerifiedAt).not.toBeNull();

    const tokens = await db.select().from(schema.emailVerificationTokens);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.consumedAt).not.toBeNull();
  });

  it("rejects an unknown token with 400 and same problem type", async () => {
    const res = await app.request("/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "totally-bogus-token-1234567890" }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const body = (await res.json()) as { type?: string };
    expect(body.type).toBe("/problems/invalid-verification-token");
  });

  it("rejects a re-used token with 400 (single-use enforcement)", async () => {
    await app.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "ver-reuse@example.com",
        password: VALID_PASSWORD,
        fullName: "Reuse Test",
        phone: "+359",
      }),
    });
    const token = tokenFromLastEmail();

    const first = await app.request("/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(first.status).toBe(200);

    const second = await app.request("/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(second.status).toBe(400);
  });

  it("rejects an expired token with 400", async () => {
    await app.request("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "ver-expired@example.com",
        password: VALID_PASSWORD,
        fullName: "Expired Test",
        phone: "+359",
      }),
    });
    const token = tokenFromLastEmail();

    // Push the token's expiry into the past directly in the DB.
    const db = getDb();
    await db.execute(
      sql`UPDATE email_verification_tokens SET expires_at = now() - interval '1 minute'`,
    );

    const res = await app.request("/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects requests without a token with 400 (validation)", async () => {
    const res = await app.request("/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /auth/resend-verification", () => {
  it("requires authentication", async () => {
    const res = await app.request("/auth/resend-verification", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("sends another verification email for an unverified user", async () => {
    const seeded = await seedUnverifiedUser({ email: "resend1@example.com" });
    const cookie = await loginAndGetCookie(seeded.email, seeded.password);

    const stub = getStubTransportForTests();
    expect(stub.sent).toHaveLength(0); // login does not send mail

    const res = await app.request("/auth/resend-verification", {
      method: "POST",
      headers: { Cookie: `${sessionCookieName()}=${cookie}` },
    });
    expect(res.status).toBe(200);
    expect(stub.sent).toHaveLength(1);
    expect(stub.sent[0]!.to).toBe("resend1@example.com");
  });

  it("returns 200 silently for an already-verified user (no enumeration)", async () => {
    // Verified user (not via the register endpoint, so no email).
    const db = getDb();
    const passwordHash = await hashPassword(VALID_PASSWORD);
    const [user] = await db
      .insert(schema.users)
      .values({
        email: "verified@example.com",
        passwordHash,
        role: "customer",
        accountType: "personal",
        emailVerifiedAt: new Date(),
      })
      .returning();
    await db.insert(schema.customerProfiles).values({
      userId: user!.id,
      fullName: "Already Verified",
      phone: "+359",
    });
    const cookie = await loginAndGetCookie("verified@example.com", VALID_PASSWORD);

    const stub = getStubTransportForTests();
    stub.reset(); // login does not send, but be defensive
    const res = await app.request("/auth/resend-verification", {
      method: "POST",
      headers: { Cookie: `${sessionCookieName()}=${cookie}` },
    });
    expect(res.status).toBe(200);
    expect(stub.sent).toHaveLength(0); // no email sent for a verified user
  });

  it("rate-limits at 3 per hour (4th call returns 429)", async () => {
    const seeded = await seedUnverifiedUser({ email: "ratelimit@example.com" });
    const cookie = await loginAndGetCookie(seeded.email, seeded.password);

    const stub = getStubTransportForTests();
    for (let i = 0; i < 3; i++) {
      const res = await app.request("/auth/resend-verification", {
        method: "POST",
        headers: { Cookie: `${sessionCookieName()}=${cookie}` },
      });
      expect(res.status).toBe(200);
    }
    expect(stub.sent.length).toBe(3);

    const fourth = await app.request("/auth/resend-verification", {
      method: "POST",
      headers: { Cookie: `${sessionCookieName()}=${cookie}` },
    });
    expect(fourth.status).toBe(429);
    const body = (await fourth.json()) as { type?: string };
    expect(body.type).toBe("/problems/resend-rate-limited");

    // Crucially: the 4th call did NOT issue a new token row OR send mail.
    expect(stub.sent.length).toBe(3);
  });
});
