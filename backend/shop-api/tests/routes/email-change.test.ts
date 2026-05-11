import { hashPassword, verifyPassword } from "@shop/auth";
import { schema } from "@shop/db";
import { and, eq, sql } from "drizzle-orm";
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
const WRONG_PASSWORD = "WrongGuess99!";

function extractSessionCookie(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const name = sessionCookieName();
  const match = setCookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match?.[1] ?? null;
}

/** Pull the `?token=...` value from the URL inside the most recent email-change verify email. */
function tokenFromLastVerifyEmail(): string {
  const stub = getStubTransportForTests();
  const last = stub.findLast(
    (e) => e.templateId === "auth.email-change-verify",
  );
  if (!last) throw new Error("no verify email recorded");
  const url = stub.extractUrl(last);
  if (!url) throw new Error("no URL in email body");
  const match = url.match(/[?&]token=([^&\s]+)/);
  if (!match || !match[1]) throw new Error(`no token in URL: ${url}`);
  return decodeURIComponent(match[1]);
}

/** Seed a verified customer with a known password. */
async function seedVerifiedUser(opts?: {
  email?: string;
}): Promise<{ id: string; email: string; password: string }> {
  const db = getDb();
  const email = (opts?.email ?? "verified@example.com").toLowerCase();
  const passwordHash = await hashPassword(VALID_PASSWORD);
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
    fullName: "Verified Test",
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

function cookieHeader(token: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Cookie: `${sessionCookieName()}=${token}`,
  };
}

describe("POST /auth/email-change/request", () => {
  it("issues a token, sends a verify email to the new address AND an alert to the old address", async () => {
    const seeded = await seedVerifiedUser({ email: "ec1@example.com" });
    const cookie = await loginAndGetCookie(seeded.email, seeded.password);

    const res = await app.request("/auth/email-change/request", {
      method: "POST",
      headers: cookieHeader(cookie),
      body: JSON.stringify({
        currentPassword: VALID_PASSWORD,
        newEmail: "new1@example.com",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const stub = getStubTransportForTests();
    const verify = stub.findLast(
      (e) => e.templateId === "auth.email-change-verify",
    );
    expect(verify).toBeTruthy();
    expect(verify!.to).toBe("new1@example.com");
    const verifyUrl = stub.extractUrl(verify!);
    expect(verifyUrl).toContain("/account/email-change/verify?token=");

    const alert = stub.findLast(
      (e) => e.templateId === "auth.email-change-alert",
    );
    expect(alert).toBeTruthy();
    expect(alert!.to).toBe(seeded.email);
    // The alert body should plainly show the proposed new address.
    expect(alert!.text).toContain("new1@example.com");

    // Token row exists with kind=email_change and the new address attached.
    const db = getDb();
    const tokens = await db
      .select()
      .from(schema.emailVerificationTokens)
      .where(eq(schema.emailVerificationTokens.userId, seeded.id));
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.kind).toBe("email_change");
    expect(tokens[0]!.newEmail).toBe("new1@example.com");
    expect(tokens[0]!.consumedAt).toBeNull();

    // users.email is still the OLD address — the change is gated on verify.
    const [user] = await db
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, seeded.id));
    expect(user!.email).toBe(seeded.email);
  });

  it("rejects without a session cookie with 401", async () => {
    const res = await app.request("/auth/email-change/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currentPassword: VALID_PASSWORD,
        newEmail: "x@example.com",
      }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects with 401 when the current password is wrong (no email sent, no token issued)", async () => {
    const seeded = await seedVerifiedUser({ email: "ec-wrongpw@example.com" });
    const cookie = await loginAndGetCookie(seeded.email, seeded.password);

    const res = await app.request("/auth/email-change/request", {
      method: "POST",
      headers: cookieHeader(cookie),
      body: JSON.stringify({
        currentPassword: WRONG_PASSWORD,
        newEmail: "new@example.com",
      }),
    });
    expect(res.status).toBe(401);

    const stub = getStubTransportForTests();
    expect(
      stub.sent.filter(
        (e) =>
          e.templateId === "auth.email-change-verify" ||
          e.templateId === "auth.email-change-alert",
      ),
    ).toHaveLength(0);

    const db = getDb();
    const tokens = await db
      .select()
      .from(schema.emailVerificationTokens)
      .where(
        and(
          eq(schema.emailVerificationTokens.userId, seeded.id),
          eq(schema.emailVerificationTokens.kind, "email_change"),
        ),
      );
    expect(tokens).toHaveLength(0);
  });

  it("rejects a request to change to the current email with 400 validation", async () => {
    const seeded = await seedVerifiedUser({ email: "ec-self@example.com" });
    const cookie = await loginAndGetCookie(seeded.email, seeded.password);

    const res = await app.request("/auth/email-change/request", {
      method: "POST",
      headers: cookieHeader(cookie),
      body: JSON.stringify({
        currentPassword: VALID_PASSWORD,
        newEmail: seeded.email,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      errors?: { path: string; message: string }[];
    };
    expect(body.errors).toBeTruthy();
    expect(body.errors!.some((e) => e.path === "newEmail")).toBe(true);
  });

  it("rejects a malformed new email with 400 (validation, via Zod)", async () => {
    const seeded = await seedVerifiedUser({ email: "ec-bad@example.com" });
    const cookie = await loginAndGetCookie(seeded.email, seeded.password);

    const res = await app.request("/auth/email-change/request", {
      method: "POST",
      headers: cookieHeader(cookie),
      body: JSON.stringify({
        currentPassword: VALID_PASSWORD,
        newEmail: "not-an-email",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("silently 200s when the new email is already used by another active user (enumeration resistance)", async () => {
    const seeded = await seedVerifiedUser({ email: "ec-attacker@example.com" });
    const other = await seedVerifiedUser({ email: "victim@example.com" });
    const cookie = await loginAndGetCookie(seeded.email, seeded.password);

    const res = await app.request("/auth/email-change/request", {
      method: "POST",
      headers: cookieHeader(cookie),
      body: JSON.stringify({
        currentPassword: VALID_PASSWORD,
        newEmail: other.email,
      }),
    });
    // CRITICAL: still 200. A 409 here would leak that the address is
    // registered — defeats the no-enumeration contract.
    expect(res.status).toBe(200);

    // No emails sent — neither a verify (no point) nor an alert (we don't
    // spam the legitimate owner).
    const stub = getStubTransportForTests();
    expect(
      stub.sent.filter(
        (e) =>
          e.templateId === "auth.email-change-verify" ||
          e.templateId === "auth.email-change-alert",
      ),
    ).toHaveLength(0);

    // No token row issued either.
    const db = getDb();
    const tokens = await db
      .select()
      .from(schema.emailVerificationTokens)
      .where(
        and(
          eq(schema.emailVerificationTokens.userId, seeded.id),
          eq(schema.emailVerificationTokens.kind, "email_change"),
        ),
      );
    expect(tokens).toHaveLength(0);
  });

  it("rate-limits internally without leaking the cap (4th call still 200, no further emails)", async () => {
    const seeded = await seedVerifiedUser({ email: "ec-rl@example.com" });
    const cookie = await loginAndGetCookie(seeded.email, seeded.password);
    const stub = getStubTransportForTests();

    for (let i = 0; i < 3; i++) {
      const res = await app.request("/auth/email-change/request", {
        method: "POST",
        headers: cookieHeader(cookie),
        body: JSON.stringify({
          currentPassword: VALID_PASSWORD,
          newEmail: `new${i}@example.com`,
        }),
      });
      expect(res.status).toBe(200);
    }
    expect(
      stub.sent.filter((e) => e.templateId === "auth.email-change-verify"),
    ).toHaveLength(3);

    const fourth = await app.request("/auth/email-change/request", {
      method: "POST",
      headers: cookieHeader(cookie),
      body: JSON.stringify({
        currentPassword: VALID_PASSWORD,
        newEmail: "new4@example.com",
      }),
    });
    expect(fourth.status).toBe(200);
    expect(
      stub.sent.filter((e) => e.templateId === "auth.email-change-verify"),
    ).toHaveLength(3);
  });
});

describe("POST /auth/email-change/verify/check", () => {
  it("returns 200 + valid:true + newEmail for a live token, and does NOT consume it", async () => {
    const seeded = await seedVerifiedUser({ email: "ec-check1@example.com" });
    const cookie = await loginAndGetCookie(seeded.email, seeded.password);

    await app.request("/auth/email-change/request", {
      method: "POST",
      headers: cookieHeader(cookie),
      body: JSON.stringify({
        currentPassword: VALID_PASSWORD,
        newEmail: "next@example.com",
      }),
    });
    const token = tokenFromLastVerifyEmail();

    const res = await app.request("/auth/email-change/verify/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { valid: boolean; newEmail: string };
    expect(body.valid).toBe(true);
    expect(body.newEmail).toBe("next@example.com");

    // Crucially: check did NOT consume the token.
    const db = getDb();
    const tokens = await db
      .select()
      .from(schema.emailVerificationTokens)
      .where(eq(schema.emailVerificationTokens.userId, seeded.id));
    expect(tokens[0]!.consumedAt).toBeNull();
  });

  it("returns 400 + /problems/invalid-email-change-token for an unknown token", async () => {
    const res = await app.request("/auth/email-change/verify/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "totally-bogus-token-1234567890" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { type?: string };
    expect(body.type).toBe("/problems/invalid-email-change-token");
  });

  it("returns 400 for an already-consumed token", async () => {
    const seeded = await seedVerifiedUser({ email: "ec-used@example.com" });
    const cookie = await loginAndGetCookie(seeded.email, seeded.password);

    await app.request("/auth/email-change/request", {
      method: "POST",
      headers: cookieHeader(cookie),
      body: JSON.stringify({
        currentPassword: VALID_PASSWORD,
        newEmail: "used@example.com",
      }),
    });
    const token = tokenFromLastVerifyEmail();

    await app.request("/auth/email-change/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });

    const res = await app.request("/auth/email-change/verify/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { type?: string };
    expect(body.type).toBe("/problems/invalid-email-change-token");
  });

  it("returns 400 for an expired token", async () => {
    const seeded = await seedVerifiedUser({ email: "ec-exp@example.com" });
    const cookie = await loginAndGetCookie(seeded.email, seeded.password);

    await app.request("/auth/email-change/request", {
      method: "POST",
      headers: cookieHeader(cookie),
      body: JSON.stringify({
        currentPassword: VALID_PASSWORD,
        newEmail: "exp@example.com",
      }),
    });
    const token = tokenFromLastVerifyEmail();

    const db = getDb();
    await db.execute(
      sql`UPDATE email_verification_tokens SET expires_at = now() - interval '1 minute' WHERE kind = 'email_change'`,
    );

    const res = await app.request("/auth/email-change/verify/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for a token whose destination has been taken by someone else", async () => {
    // Race the user's intended address being claimed between request and
    // verify — by another user registering it. The check must report dead.
    const seeded = await seedVerifiedUser({ email: "ec-race@example.com" });
    const cookie = await loginAndGetCookie(seeded.email, seeded.password);

    await app.request("/auth/email-change/request", {
      method: "POST",
      headers: cookieHeader(cookie),
      body: JSON.stringify({
        currentPassword: VALID_PASSWORD,
        newEmail: "wanted@example.com",
      }),
    });
    const token = tokenFromLastVerifyEmail();

    // Someone else claims wanted@ in the meantime.
    await seedVerifiedUser({ email: "wanted@example.com" });

    const res = await app.request("/auth/email-change/verify/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /auth/email-change/verify", () => {
  it("rotates users.email, marks the new address verified, drops all sessions, sends the notification to the OLD address", async () => {
    const seeded = await seedVerifiedUser({ email: "ec-old@example.com" });
    const cookieA = await loginAndGetCookie(seeded.email, seeded.password);
    const cookieB = await loginAndGetCookie(seeded.email, seeded.password);

    const db = getDb();
    expect(
      await db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.userId, seeded.id)),
    ).toHaveLength(2);

    await app.request("/auth/email-change/request", {
      method: "POST",
      headers: cookieHeader(cookieA),
      body: JSON.stringify({
        currentPassword: VALID_PASSWORD,
        newEmail: "ec-new@example.com",
      }),
    });
    const token = tokenFromLastVerifyEmail();

    const stub = getStubTransportForTests();
    const beforeVerify = stub.sent.length;

    const res = await app.request("/auth/email-change/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(200);

    // Email rotated + verified-at set.
    const [user] = await db
      .select({
        email: schema.users.email,
        emailVerifiedAt: schema.users.emailVerifiedAt,
      })
      .from(schema.users)
      .where(eq(schema.users.id, seeded.id));
    expect(user!.email).toBe("ec-new@example.com");
    expect(user!.emailVerifiedAt).not.toBeNull();

    // Token consumed.
    const tokens = await db
      .select()
      .from(schema.emailVerificationTokens)
      .where(eq(schema.emailVerificationTokens.userId, seeded.id));
    expect(tokens[0]!.consumedAt).not.toBeNull();

    // All sessions for the user dropped.
    expect(
      await db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.userId, seeded.id)),
    ).toHaveLength(0);

    // Both cookies now dead.
    const meA = await app.request("/auth/me", {
      headers: { Cookie: `${sessionCookieName()}=${cookieA}` },
    });
    expect(meA.status).toBe(401);
    const meB = await app.request("/auth/me", {
      headers: { Cookie: `${sessionCookieName()}=${cookieB}` },
    });
    expect(meB.status).toBe(401);

    // Notification sent to the OLD address.
    expect(stub.sent.length).toBe(beforeVerify + 1);
    const last = stub.sent[stub.sent.length - 1]!;
    expect(last.templateId).toBe("auth.email-changed");
    expect(last.to).toBe("ec-old@example.com");
    // The body of the notification surfaces the new address so the
    // recipient knows what the account is now associated with.
    expect(last.text).toContain("ec-new@example.com");
  });

  it("the new email works on /auth/login; the old email no longer logs in", async () => {
    const seeded = await seedVerifiedUser({ email: "ec-login@example.com" });
    const cookie = await loginAndGetCookie(seeded.email, seeded.password);

    await app.request("/auth/email-change/request", {
      method: "POST",
      headers: cookieHeader(cookie),
      body: JSON.stringify({
        currentPassword: VALID_PASSWORD,
        newEmail: "ec-login-new@example.com",
      }),
    });
    const token = tokenFromLastVerifyEmail();
    const verify = await app.request("/auth/email-change/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(verify.status).toBe(200);

    // OLD email no longer logs in (no user has it).
    const oldLogin = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: seeded.email,
        password: seeded.password,
        rememberMe: false,
      }),
    });
    expect(oldLogin.status).toBe(401);

    // NEW email + original password works.
    const newLogin = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "ec-login-new@example.com",
        password: seeded.password,
        rememberMe: false,
      }),
    });
    expect(newLogin.status).toBe(200);

    // Sanity: password is still the same (we only rotated the email).
    const db = getDb();
    const [user] = await db
      .select({ passwordHash: schema.users.passwordHash })
      .from(schema.users)
      .where(eq(schema.users.email, "ec-login-new@example.com"));
    expect(await verifyPassword(user!.passwordHash, VALID_PASSWORD)).toBe(true);
  });

  it("rejects an unknown token with 400 + /problems/invalid-email-change-token", async () => {
    const res = await app.request("/auth/email-change/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "totally-bogus-token-1234567890" }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const body = (await res.json()) as { type?: string };
    expect(body.type).toBe("/problems/invalid-email-change-token");
  });

  it("rejects a re-used token with the same generic 400", async () => {
    const seeded = await seedVerifiedUser({ email: "ec-reuse@example.com" });
    const cookie = await loginAndGetCookie(seeded.email, seeded.password);

    await app.request("/auth/email-change/request", {
      method: "POST",
      headers: cookieHeader(cookie),
      body: JSON.stringify({
        currentPassword: VALID_PASSWORD,
        newEmail: "ec-reuse-new@example.com",
      }),
    });
    const token = tokenFromLastVerifyEmail();

    const first = await app.request("/auth/email-change/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(first.status).toBe(200);

    const second = await app.request("/auth/email-change/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(second.status).toBe(400);
    const body = (await second.json()) as { type?: string };
    expect(body.type).toBe("/problems/invalid-email-change-token");
  });

  it("rejects an expired token with the same generic 400", async () => {
    const seeded = await seedVerifiedUser({ email: "ec-exp2@example.com" });
    const cookie = await loginAndGetCookie(seeded.email, seeded.password);

    await app.request("/auth/email-change/request", {
      method: "POST",
      headers: cookieHeader(cookie),
      body: JSON.stringify({
        currentPassword: VALID_PASSWORD,
        newEmail: "ec-exp2-new@example.com",
      }),
    });
    const token = tokenFromLastVerifyEmail();

    const db = getDb();
    await db.execute(
      sql`UPDATE email_verification_tokens SET expires_at = now() - interval '1 minute' WHERE kind = 'email_change'`,
    );

    const res = await app.request("/auth/email-change/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects when the destination has been taken between request and verify", async () => {
    const seeded = await seedVerifiedUser({ email: "ec-race2@example.com" });
    const cookie = await loginAndGetCookie(seeded.email, seeded.password);

    await app.request("/auth/email-change/request", {
      method: "POST",
      headers: cookieHeader(cookie),
      body: JSON.stringify({
        currentPassword: VALID_PASSWORD,
        newEmail: "ec-wanted@example.com",
      }),
    });
    const token = tokenFromLastVerifyEmail();

    // Someone else registers the target address in the gap.
    await seedVerifiedUser({ email: "ec-wanted@example.com" });

    const res = await app.request("/auth/email-change/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(400);

    // The original user's email is unchanged.
    const db = getDb();
    const [user] = await db
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, seeded.id));
    expect(user!.email).toBe(seeded.email);
  });

  it("invalidates OTHER outstanding email-change tokens after a successful verify (parallel-token defence)", async () => {
    // An attacker phished token #1 (e.g. by intercepting a verify email
    // for an old typo'd destination they control). The legitimate user
    // notices, re-requests for the right address (#2), and confirms via
    // #2. After that, #1 must NOT still be redeemable — the attacker must
    // not be able to come back later and flip the email to their own
    // address.
    const seeded = await seedVerifiedUser({
      email: "ec-multi@example.com",
    });
    const cookie = await loginAndGetCookie(seeded.email, seeded.password);

    await app.request("/auth/email-change/request", {
      method: "POST",
      headers: cookieHeader(cookie),
      body: JSON.stringify({
        currentPassword: VALID_PASSWORD,
        newEmail: "attacker@example.com",
      }),
    });
    const phishedToken = tokenFromLastVerifyEmail();

    await app.request("/auth/email-change/request", {
      method: "POST",
      headers: cookieHeader(cookie),
      body: JSON.stringify({
        currentPassword: VALID_PASSWORD,
        newEmail: "intended@example.com",
      }),
    });
    const userToken = tokenFromLastVerifyEmail();
    expect(userToken).not.toBe(phishedToken);

    // User confirms their own (newer) token.
    const ok = await app.request("/auth/email-change/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: userToken }),
    });
    expect(ok.status).toBe(200);

    // Attacker tries the older token — must fail with the same generic 400.
    const attacker = await app.request("/auth/email-change/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: phishedToken }),
    });
    expect(attacker.status).toBe(400);

    // And the email is the user's choice, not the attacker's.
    const db = getDb();
    const [user] = await db
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, seeded.id));
    expect(user!.email).toBe("intended@example.com");
  });

  it("rejects requests with a missing token with 400 (validation)", async () => {
    const res = await app.request("/auth/email-change/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("signup verification tokens are NOT redeemable as email-change tokens (kind isolation)", async () => {
    // Both flows live in the same email_verification_tokens table, distinguished
    // by `kind`. A signup token must not be redeemable via /email-change/verify
    // (and vice versa — that test lives next to the signup flow).
    const seeded = await seedVerifiedUser({ email: "ec-isolation@example.com" });
    // Manually insert a signup-kind token for the user.
    const db = getDb();
    const { randomBytes, createHash } = await import("node:crypto");
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await db.insert(schema.emailVerificationTokens).values({
      tokenHash,
      userId: seeded.id,
      kind: "signup",
      newEmail: null,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const res = await app.request("/auth/email-change/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(400);
  });
});
