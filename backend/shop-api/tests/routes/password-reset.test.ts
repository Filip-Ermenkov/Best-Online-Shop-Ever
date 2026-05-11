import { hashPassword, verifyPassword } from "@shop/auth";
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
const NEW_PASSWORD = "BrandNewPa55!";

function extractSessionCookie(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const name = sessionCookieName();
  const match = setCookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match?.[1] ?? null;
}

/** Pull the `?token=...` value from the URL inside the most recent reset email. */
function tokenFromLastResetEmail(): string {
  const stub = getStubTransportForTests();
  const last = stub.findLast(
    (e) => e.templateId === "auth.password-reset",
  );
  if (!last) throw new Error("no reset email recorded");
  const url = stub.extractUrl(last);
  if (!url) throw new Error("no URL in email body");
  const match = url.match(/[?&]token=([^&\s]+)/);
  if (!match || !match[1]) throw new Error(`no token in URL: ${url}`);
  return decodeURIComponent(match[1]);
}

/** Seed a verified user directly. */
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

describe("POST /auth/forgot-password", () => {
  it("returns 200 + sends an email + records a token row for a known user", async () => {
    const seeded = await seedVerifiedUser({ email: "fp1@example.com" });
    const res = await app.request("/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: seeded.email }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const stub = getStubTransportForTests();
    const sent = stub.findLast((e) => e.templateId === "auth.password-reset");
    expect(sent).toBeTruthy();
    expect(sent!.to).toBe("fp1@example.com");
    const url = stub.extractUrl(sent!);
    expect(url).toContain("/account/reset-password?token=");

    const db = getDb();
    const tokens = await db.select().from(schema.passwordResetTokens);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.userId).toBe(seeded.id);
    expect(tokens[0]!.consumedAt).toBeNull();
  });

  it("returns 200 silently for an unknown email (no enumeration)", async () => {
    const res = await app.request("/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.com" }),
    });
    expect(res.status).toBe(200);

    const stub = getStubTransportForTests();
    expect(stub.sent).toHaveLength(0);

    const db = getDb();
    const tokens = await db.select().from(schema.passwordResetTokens);
    expect(tokens).toHaveLength(0);
  });

  it("returns 200 silently for a soft-deleted user", async () => {
    const db = getDb();
    const passwordHash = await hashPassword(VALID_PASSWORD);
    await db.insert(schema.users).values({
      email: "deleted@example.com",
      passwordHash,
      role: "customer",
      accountType: "personal",
      emailVerifiedAt: new Date(),
      deletedAt: new Date(),
    });
    const res = await app.request("/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "deleted@example.com" }),
    });
    expect(res.status).toBe(200);

    const stub = getStubTransportForTests();
    expect(stub.sent).toHaveLength(0);
  });

  it("rate-limits internally without leaking the cap (4th call still 200, no email)", async () => {
    const seeded = await seedVerifiedUser({ email: "fpratelimit@example.com" });
    const stub = getStubTransportForTests();

    for (let i = 0; i < 3; i++) {
      const res = await app.request("/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: seeded.email }),
      });
      expect(res.status).toBe(200);
    }
    expect(
      stub.sent.filter((e) => e.templateId === "auth.password-reset"),
    ).toHaveLength(3);

    const fourth = await app.request("/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: seeded.email }),
    });
    // CRITICAL: still 200. Returning 429 here would leak that the email is
    // registered. The hourly cap is internal — the user just doesn't get a
    // mail.
    expect(fourth.status).toBe(200);
    expect(
      stub.sent.filter((e) => e.templateId === "auth.password-reset"),
    ).toHaveLength(3);
  });

  it("rejects requests with a malformed email with 400 (validation)", async () => {
    const res = await app.request("/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /auth/reset-password/check", () => {
  it("returns 200 + valid:true for a live token, and does NOT consume it", async () => {
    const seeded = await seedVerifiedUser({ email: "check1@example.com" });
    await app.request("/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: seeded.email }),
    });
    const token = tokenFromLastResetEmail();

    const res = await app.request("/auth/reset-password/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { valid: boolean };
    expect(body.valid).toBe(true);

    // Crucially: check did NOT consume the token. The user can still
    // submit /auth/reset-password with it afterwards.
    const db = getDb();
    const tokens = await db
      .select()
      .from(schema.passwordResetTokens)
      .where(eq(schema.passwordResetTokens.userId, seeded.id));
    expect(tokens[0]!.consumedAt).toBeNull();

    // And consuming for real still works.
    const reset = await app.request("/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, newPassword: NEW_PASSWORD }),
    });
    expect(reset.status).toBe(200);
  });

  it("returns 400 + /problems/invalid-reset-token for an unknown token", async () => {
    const res = await app.request("/auth/reset-password/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "totally-bogus-token-1234567890" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { type?: string };
    expect(body.type).toBe("/problems/invalid-reset-token");
  });

  it("returns 400 for an already-consumed token (the bug the user reported)", async () => {
    const seeded = await seedVerifiedUser({ email: "check-used@example.com" });
    await app.request("/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: seeded.email }),
    });
    const token = tokenFromLastResetEmail();

    // Consume once.
    await app.request("/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, newPassword: NEW_PASSWORD }),
    });

    // Check now reports the token is dead — this is what powers the
    // reset page's on-mount "show dead-link UI immediately" behaviour.
    const res = await app.request("/auth/reset-password/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { type?: string };
    expect(body.type).toBe("/problems/invalid-reset-token");
  });

  it("returns 400 for an expired token", async () => {
    const seeded = await seedVerifiedUser({ email: "check-expired@example.com" });
    await app.request("/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: seeded.email }),
    });
    const token = tokenFromLastResetEmail();

    const db = getDb();
    await db.execute(
      sql`UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute'`,
    );

    const res = await app.request("/auth/reset-password/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /auth/reset-password", () => {
  it("after reset, Browser B's stale cookie is wiped on its next request (orphaned-cookie loop fix)", async () => {
    // Scenario the user actually hit: logged in on two browsers, reset
    // from one, the OTHER browser's cookie persists in the browser even
    // though the session row has been dropped. Without server-side cookie
    // clearing, the thin proxy keeps treating the cookie as "logged in"
    // and the user can't escape the redirect loop.
    const seeded = await seedVerifiedUser({ email: "browser-b@example.com" });
    const browserA = await loginAndGetCookie(seeded.email, seeded.password);
    const browserB = await loginAndGetCookie(seeded.email, seeded.password);
    expect(browserA).not.toBe(browserB);

    // Reset from Browser A. (Doesn't actually matter which browser does
    // the reset — the endpoint is unauthenticated.)
    await app.request("/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: seeded.email }),
    });
    const token = tokenFromLastResetEmail();
    const reset = await app.request("/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, newPassword: NEW_PASSWORD }),
    });
    expect(reset.status).toBe(200);

    // Browser B sends its old cookie to /auth/me — exactly what
    // AuthContext does on mount, which is how the loop gets entered.
    const meRes = await app.request("/auth/me", {
      headers: { Cookie: `${sessionCookieName()}=${browserB}` },
    });
    expect(meRes.status).toBe(401);

    // The response MUST carry a Set-Cookie that wipes the cookie. Without
    // this, Browser B keeps re-sending the same cookie on every page
    // navigation and the proxy keeps treating it as authenticated.
    const setCookie = meRes.headers.get("set-cookie");
    expect(setCookie).toBeTruthy();
    const cookieName = sessionCookieName();
    expect(setCookie).toContain(`${cookieName}=`);
    // The wipe is implemented as Max-Age=0 (per Hono's deleteCookie) —
    // accept any of the canonical "this cookie is gone" forms a future
    // refactor might switch to.
    const wipesCookie =
      /Max-Age=0/i.test(setCookie!) ||
      /Expires=Thu, 01 Jan 1970/i.test(setCookie!);
    expect(wipesCookie).toBe(true);
  });

  it("rotates the password, sends a notification, and drops all sessions", async () => {
    const seeded = await seedVerifiedUser({ email: "reset1@example.com" });

    // Log in TWICE — two sessions on different devices. The reset must drop
    // both, even though neither one's cookie is sent with the reset request.
    const cookieA = await loginAndGetCookie(seeded.email, seeded.password);
    const cookieB = await loginAndGetCookie(seeded.email, seeded.password);

    const db = getDb();
    expect(
      await db.select().from(schema.sessions).where(eq(schema.sessions.userId, seeded.id)),
    ).toHaveLength(2);

    // Trigger the email + grab the token.
    await app.request("/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: seeded.email }),
    });
    const token = tokenFromLastResetEmail();

    const stub = getStubTransportForTests();
    const beforeReset = stub.sent.length;

    const res = await app.request("/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, newPassword: NEW_PASSWORD }),
    });
    expect(res.status).toBe(200);

    // Password rotated.
    const [user] = await db
      .select({ passwordHash: schema.users.passwordHash })
      .from(schema.users)
      .where(eq(schema.users.id, seeded.id));
    expect(user).toBeTruthy();
    expect(await verifyPassword(user!.passwordHash, NEW_PASSWORD)).toBe(true);
    expect(await verifyPassword(user!.passwordHash, VALID_PASSWORD)).toBe(false);

    // Token consumed.
    const tokens = await db
      .select()
      .from(schema.passwordResetTokens)
      .where(eq(schema.passwordResetTokens.userId, seeded.id));
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.consumedAt).not.toBeNull();

    // ALL sessions for the user dropped.
    expect(
      await db.select().from(schema.sessions).where(eq(schema.sessions.userId, seeded.id)),
    ).toHaveLength(0);

    // Both cookies are now dead — /auth/me on either returns 401.
    const meA = await app.request("/auth/me", {
      headers: { Cookie: `${sessionCookieName()}=${cookieA}` },
    });
    expect(meA.status).toBe(401);
    const meB = await app.request("/auth/me", {
      headers: { Cookie: `${sessionCookieName()}=${cookieB}` },
    });
    expect(meB.status).toBe(401);

    // Notification email sent.
    expect(stub.sent.length).toBe(beforeReset + 1);
    const last = stub.sent[stub.sent.length - 1]!;
    expect(last.templateId).toBe("auth.password-changed");
    expect(last.to).toBe("reset1@example.com");
  });

  it("the new password works on /auth/login", async () => {
    const seeded = await seedVerifiedUser({ email: "reset-login@example.com" });
    await app.request("/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: seeded.email }),
    });
    const token = tokenFromLastResetEmail();

    const reset = await app.request("/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, newPassword: NEW_PASSWORD }),
    });
    expect(reset.status).toBe(200);

    // Old password rejected.
    const oldLogin = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: seeded.email, password: VALID_PASSWORD, rememberMe: false }),
    });
    expect(oldLogin.status).toBe(401);

    // New password works.
    const newLogin = await app.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: seeded.email, password: NEW_PASSWORD, rememberMe: false }),
    });
    expect(newLogin.status).toBe(200);
  });

  it("rejects an unknown token with 400 + /problems/invalid-reset-token", async () => {
    const res = await app.request("/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: "totally-bogus-token-1234567890",
        newPassword: NEW_PASSWORD,
      }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const body = (await res.json()) as { type?: string };
    expect(body.type).toBe("/problems/invalid-reset-token");
  });

  it("rejects a re-used token with the same generic 400", async () => {
    const seeded = await seedVerifiedUser({ email: "reset-reuse@example.com" });
    await app.request("/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: seeded.email }),
    });
    const token = tokenFromLastResetEmail();

    const first = await app.request("/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, newPassword: NEW_PASSWORD }),
    });
    expect(first.status).toBe(200);

    const second = await app.request("/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, newPassword: "AnotherPa55!OK" }),
    });
    expect(second.status).toBe(400);
    const body = (await second.json()) as { type?: string };
    expect(body.type).toBe("/problems/invalid-reset-token");
  });

  it("rejects an expired token with the same generic 400", async () => {
    const seeded = await seedVerifiedUser({ email: "reset-expired@example.com" });
    await app.request("/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: seeded.email }),
    });
    const token = tokenFromLastResetEmail();

    const db = getDb();
    await db.execute(
      sql`UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute'`,
    );

    const res = await app.request("/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, newPassword: NEW_PASSWORD }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { type?: string };
    expect(body.type).toBe("/problems/invalid-reset-token");
  });

  it("rejects a weak new password with 400 (validation, distinct problem type)", async () => {
    const seeded = await seedVerifiedUser({ email: "reset-weak@example.com" });
    await app.request("/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: seeded.email }),
    });
    const token = tokenFromLastResetEmail();

    const res = await app.request("/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, newPassword: "short" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      type?: string;
      errors?: { path: string; message: string }[];
    };
    // Distinct from invalid-reset-token: a validation problem with field
    // errors. The frontend renders these inline against the password input.
    expect(body.type).not.toBe("/problems/invalid-reset-token");
    expect(body.errors).toBeTruthy();

    // Validation failed BEFORE the token was consumed — the user can retry
    // with a stronger password using the same link.
    const db = getDb();
    const tokens = await db
      .select()
      .from(schema.passwordResetTokens)
      .where(eq(schema.passwordResetTokens.userId, seeded.id));
    expect(tokens[0]!.consumedAt).toBeNull();
  });

  it("invalidates OTHER outstanding reset tokens after a successful reset", async () => {
    // The bug class: an attacker phished token #1, the user (unaware) re-
    // requests and gets token #2, the user resets via #2. Without this
    // safeguard, the attacker could STILL reset using #1. We invalidate
    // every live reset token for the user atomically with the consumption.
    const seeded = await seedVerifiedUser({ email: "reset-multi@example.com" });

    await app.request("/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: seeded.email }),
    });
    const phishedToken = tokenFromLastResetEmail();

    await app.request("/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: seeded.email }),
    });
    const userToken = tokenFromLastResetEmail();
    expect(userToken).not.toBe(phishedToken);

    // User resets with their own (newer) token.
    const ok = await app.request("/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: userToken, newPassword: NEW_PASSWORD }),
    });
    expect(ok.status).toBe(200);

    // Attacker tries the older token — must fail with the same generic 400.
    const attacker = await app.request("/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: phishedToken, newPassword: "Attacker99!" }),
    });
    expect(attacker.status).toBe(400);

    // And the password is still the user's choice, not the attacker's.
    const db = getDb();
    const [user] = await db
      .select({ passwordHash: schema.users.passwordHash })
      .from(schema.users)
      .where(eq(schema.users.id, seeded.id));
    expect(await verifyPassword(user!.passwordHash, NEW_PASSWORD)).toBe(true);
    expect(await verifyPassword(user!.passwordHash, "Attacker99!")).toBe(false);
  });

  it("rejects requests with a missing token with 400 (validation)", async () => {
    const res = await app.request("/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newPassword: NEW_PASSWORD }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects requests with a missing newPassword with 400 (validation)", async () => {
    const res = await app.request("/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "x".repeat(40) }),
    });
    expect(res.status).toBe(400);
  });
});
