import {
  encryptSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashPassword,
  hashRecoveryCode,
  loadMfaKey,
  signChallenge,
  totpCode,
  verifyTotp,
} from "@shop/auth";
import { schema } from "@shop/db";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { sessionCookieName } from "../../src/lib/cookies.js";
import { getDb } from "../../src/lib/db.js";

let app: ReturnType<typeof buildApp>;
let encKey: Buffer;

beforeAll(() => {
  app = buildApp();
  encKey = loadMfaKey(process.env.ADMIN_MFA_ENCRYPTION_KEY);
});

const ADMIN_EMAIL = "admin@shop.bg";
const ADMIN_PASSWORD = "correct horse battery staple"; // ≥12, NIST-style
const CHALLENGE_KEY = process.env.ADMIN_MFA_CHALLENGE_KEY!;

function extractSessionCookie(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const name = sessionCookieName();
  const match = setCookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match?.[1] ?? null;
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

interface SeedAdminOpts {
  email?: string;
  password?: string;
  enrolled?: boolean;
  recoveryCodes?: string[];
}

async function seedAdmin(opts: SeedAdminOpts = {}) {
  const db = getDb();
  const email = (opts.email ?? ADMIN_EMAIL).toLowerCase();
  const password = opts.password ?? ADMIN_PASSWORD;
  const passwordHash = await hashPassword(password);

  let secret: string | undefined;
  let mfaSecretEncrypted: string | null = null;
  const enrolled = opts.enrolled ?? false;
  if (enrolled) {
    secret = generateTotpSecret();
    mfaSecretEncrypted = encryptSecret(secret, encKey);
  }

  const [user] = await db
    .insert(schema.users)
    .values({
      email,
      passwordHash,
      role: "admin",
      accountType: null,
      emailVerifiedAt: new Date(),
      mfaEnabled: enrolled,
      mfaSecretEncrypted,
    })
    .returning();
  if (!user) throw new Error("seed admin failed");

  if (opts.recoveryCodes?.length) {
    const hashes = await Promise.all(opts.recoveryCodes.map(hashRecoveryCode));
    await db
      .insert(schema.mfaRecoveryCodes)
      .values(hashes.map((codeHash) => ({ userId: user.id, codeHash })));
  }
  return { user, secret, password, email };
}

async function seedCustomer(email = "ivan@example.com", password = ADMIN_PASSWORD) {
  const db = getDb();
  const passwordHash = await hashPassword(password);
  const [user] = await db
    .insert(schema.users)
    .values({
      email: email.toLowerCase(),
      passwordHash,
      role: "customer",
      accountType: "personal",
      emailVerifiedAt: new Date(),
    })
    .returning();
  return user!;
}

/** Drive the full two-step login for an enrolled admin; returns the session cookie. */
async function loginEnrolled(secret: string, email = ADMIN_EMAIL, password = ADMIN_PASSWORD) {
  const r1 = await post("/admin/auth/login", { email, password });
  const { challenge } = (await r1.json()) as { challenge: string };
  const r2 = await post("/admin/auth/mfa", { challenge, code: totpCode(secret) });
  return { res: r2, cookie: extractSessionCookie(r2.headers.get("set-cookie")) };
}

// ─── POST /admin/auth/login (password factor) ────────────────────────────────

describe("POST /admin/auth/login", () => {
  it("returns mfa_required + a challenge (no session) for a correct enrolled admin", async () => {
    const { secret } = await seedAdmin({ enrolled: true });
    expect(secret).toBeTruthy();
    const res = await post("/admin/auth/login", {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; challenge: string };
    expect(body.status).toBe("mfa_required");
    expect(body.challenge).toBeTruthy();
    // Crucially: NO session is issued at the password step.
    expect(extractSessionCookie(res.headers.get("set-cookie"))).toBeNull();
  });

  it("returns enrollment_required for an admin who has not set up TOTP", async () => {
    await seedAdmin({ enrolled: false });
    const res = await post("/admin/auth/login", {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("enrollment_required");
  });

  it("rejects a wrong password with a generic 401", async () => {
    await seedAdmin({ enrolled: true });
    const res = await post("/admin/auth/login", {
      email: ADMIN_EMAIL,
      password: "wrong wrong wrong",
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
  });

  it("returns the SAME 401 body for an unknown email (enumeration-resistant)", async () => {
    await seedAdmin({ enrolled: true });
    const wrongPass = await post("/admin/auth/login", {
      email: ADMIN_EMAIL,
      password: "definitely not it",
    });
    const unknown = await post("/admin/auth/login", {
      email: "nobody@nowhere.test",
      password: "definitely not it",
    });
    expect(unknown.status).toBe(wrongPass.status);
    const a = (await wrongPass.json()) as Record<string, unknown>;
    const b = (await unknown.json()) as Record<string, unknown>;
    // The bodies must be identical EXCEPT `instance` — that field is the
    // per-request id (RFC 9457 instance URI), intentionally unique per call and
    // not an enumeration signal. Strip it before the deep-equal.
    delete a.instance;
    delete b.instance;
    expect(b).toEqual(a);
    expect(b).toEqual({
      type: "about:blank",
      title: "Unauthorized",
      status: 401,
      detail: "Invalid email or password.",
    });
  });

  it("does NOT reveal the admin surface to a valid CUSTOMER (same 401)", async () => {
    await seedCustomer("ivan@example.com", ADMIN_PASSWORD);
    // A customer with their correct password is still rejected at /admin/auth.
    const res = await post("/admin/auth/login", {
      email: "ivan@example.com",
      password: ADMIN_PASSWORD,
    });
    expect(res.status).toBe(401);
  });

  it("locks the admin after 5 failed attempts (429)", async () => {
    await seedAdmin({ enrolled: true });
    for (let i = 0; i < 5; i++) {
      await post("/admin/auth/login", { email: ADMIN_EMAIL, password: "nope nope nope" });
    }
    const res = await post("/admin/auth/login", {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD, // even the correct one is locked out now
    });
    expect(res.status).toBe(429);
  });
});

// ─── POST /admin/auth/mfa (TOTP / recovery factor) ───────────────────────────

describe("POST /admin/auth/mfa", () => {
  it("opens an admin session for a valid TOTP code (30-min idle window)", async () => {
    const { secret, user } = await seedAdmin({ enrolled: true });
    const { res, cookie } = await loginEnrolled(secret!);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: { role: string; email: string };
      recoveryCodeUsed: boolean;
    };
    expect(body.user.role).toBe("admin");
    expect(body.recoveryCodeUsed).toBe(false);
    expect(cookie).toBeTruthy();

    // The session is real: GET /admin/auth/me succeeds with the cookie.
    const me = await app.request("/admin/auth/me", {
      headers: { cookie: `${sessionCookieName()}=${cookie}` },
    });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { user: { id: string } };
    expect(meBody.user.id).toBe(user.id);
  });

  it("rejects a reused TOTP code within its window (replay guard)", async () => {
    const { secret } = await seedAdmin({ enrolled: true });
    const code = totpCode(secret!);

    const r1a = await post("/admin/auth/login", {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    const c1 = ((await r1a.json()) as { challenge: string }).challenge;
    const first = await post("/admin/auth/mfa", { challenge: c1, code });
    expect(first.status).toBe(200);

    // Fresh challenge, SAME code — the replay guard must reject it.
    const r2a = await post("/admin/auth/login", {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    const c2 = ((await r2a.json()) as { challenge: string }).challenge;
    const replay = await post("/admin/auth/mfa", { challenge: c2, code });
    expect(replay.status).toBe(401);
  });

  it("rejects a wrong TOTP code", async () => {
    const { secret } = await seedAdmin({ enrolled: true });
    const r1 = await post("/admin/auth/login", {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    const { challenge } = (await r1.json()) as { challenge: string };
    // Pick a 6-digit string that is definitely not the current code.
    const realCode = totpCode(secret!);
    const wrong = realCode === "000000" ? "111111" : "000000";
    const res = await post("/admin/auth/mfa", { challenge, code: wrong });
    expect(res.status).toBe(401);
  });

  it("accepts a single-use recovery code and reports the remaining count", async () => {
    const codes = generateRecoveryCodes(3);
    const { user } = await seedAdmin({ enrolled: true, recoveryCodes: codes });
    // Mint a login challenge directly (enrolled admin path).
    const r1 = await post("/admin/auth/login", {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    const { challenge } = (await r1.json()) as { challenge: string };
    const res = await post("/admin/auth/mfa", { challenge, code: codes[0]! });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      recoveryCodeUsed: boolean;
      recoveryCodesRemaining: number;
    };
    expect(body.recoveryCodeUsed).toBe(true);
    expect(body.recoveryCodesRemaining).toBe(2);

    // The same code cannot be redeemed twice.
    const r2 = await post("/admin/auth/login", {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    const c2 = ((await r2.json()) as { challenge: string }).challenge;
    const reuse = await post("/admin/auth/mfa", { challenge: c2, code: codes[0]! });
    expect(reuse.status).toBe(401);
    // And the unused code that's left still works.
    const remainingRow = await getDb()
      .select()
      .from(schema.mfaRecoveryCodes)
      .where(eq(schema.mfaRecoveryCodes.userId, user.id));
    expect(remainingRow.filter((r) => r.usedAt === null)).toHaveLength(2);
  });

  it("rejects a forged / expired challenge", async () => {
    await seedAdmin({ enrolled: true });
    const forged = "not.a.real.challenge";
    const res = await post("/admin/auth/mfa", { challenge: forged, code: "123456" });
    expect(res.status).toBe(401);
  });

  it("rejects an enrolment-purpose challenge used at the login step", async () => {
    const { user, secret } = await seedAdmin({ enrolled: true });
    // Hand-craft an enrol-purpose token for this user — it must NOT satisfy /mfa.
    const enrolTok = signChallenge(
      { userId: user.id, purpose: "admin_mfa_enroll", ttlSeconds: 300 },
      CHALLENGE_KEY,
    );
    const res = await post("/admin/auth/mfa", {
      challenge: enrolTok,
      code: totpCode(secret!),
    });
    expect(res.status).toBe(401);
  });
});

// ─── Enrolment: setup + confirm ──────────────────────────────────────────────

describe("admin TOTP enrolment", () => {
  it("provisions a secret then enables MFA on a confirmed code, returning recovery codes", async () => {
    await seedAdmin({ enrolled: false });

    const login = await post("/admin/auth/login", {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    const enrolChallenge = ((await login.json()) as { challenge: string }).challenge;

    const setup = await post("/admin/auth/mfa/setup", { challenge: enrolChallenge });
    expect(setup.status).toBe(200);
    const setupBody = (await setup.json()) as {
      secret: string;
      otpauthUri: string;
      challenge: string;
    };
    expect(setupBody.secret).toMatch(/^[A-Z2-7]+$/);
    expect(setupBody.otpauthUri.startsWith("otpauth://totp/")).toBe(true);

    // The secret is genuinely usable: a code computed from it verifies.
    expect(verifyTotp(setupBody.secret, totpCode(setupBody.secret)).valid).toBe(true);

    const confirm = await post("/admin/auth/mfa/setup/confirm", {
      challenge: setupBody.challenge,
      code: totpCode(setupBody.secret),
    });
    expect(confirm.status).toBe(200);
    const confirmBody = (await confirm.json()) as {
      user: { role: string };
      recoveryCodes: string[];
    };
    expect(confirmBody.user.role).toBe("admin");
    expect(confirmBody.recoveryCodes).toHaveLength(10);
    // Session issued on successful enrolment.
    expect(extractSessionCookie(confirm.headers.get("set-cookie"))).toBeTruthy();

    // Subsequent login now requires MFA (not enrolment).
    const relogin = await post("/admin/auth/login", {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    expect(((await relogin.json()) as { status: string }).status).toBe("mfa_required");
  });

  it("rejects an invalid code at confirm (MFA stays disabled)", async () => {
    const { user } = await seedAdmin({ enrolled: false });
    const login = await post("/admin/auth/login", {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    const enrolChallenge = ((await login.json()) as { challenge: string }).challenge;
    const setup = await post("/admin/auth/mfa/setup", { challenge: enrolChallenge });
    const { secret, challenge } = (await setup.json()) as {
      secret: string;
      challenge: string;
    };
    const real = totpCode(secret);
    const wrong = real === "000000" ? "111111" : "000000";
    const confirm = await post("/admin/auth/mfa/setup/confirm", {
      challenge,
      code: wrong,
    });
    expect(confirm.status).toBe(401);

    const [row] = await getDb()
      .select({ mfaEnabled: schema.users.mfaEnabled })
      .from(schema.users)
      .where(eq(schema.users.id, user.id));
    expect(row!.mfaEnabled).toBe(false);
  });
});

// ─── requireAdmin gate + logout ──────────────────────────────────────────────

describe("requireAdmin gate", () => {
  it("returns 404 on /admin/auth/me with no session (surface not confirmable)", async () => {
    const res = await app.request("/admin/auth/me");
    expect(res.status).toBe(404);
  });

  it("returns 404 on /admin/auth/me for a customer session", async () => {
    // Build a real customer session via the normal login route.
    await seedCustomer("ivan@example.com", ADMIN_PASSWORD);
    const login = await post("/auth/login", {
      email: "ivan@example.com",
      password: ADMIN_PASSWORD,
    });
    const cookie = extractSessionCookie(login.headers.get("set-cookie"));
    expect(cookie).toBeTruthy();
    const res = await app.request("/admin/auth/me", {
      headers: { cookie: `${sessionCookieName()}=${cookie}` },
    });
    expect(res.status).toBe(404);
  });

  it("logs out idempotently (204) and clears the session", async () => {
    const { secret } = await seedAdmin({ enrolled: true });
    const { cookie } = await loginEnrolled(secret!);
    const out = await app.request("/admin/auth/logout", {
      method: "POST",
      headers: { cookie: `${sessionCookieName()}=${cookie}` },
    });
    expect(out.status).toBe(204);
    // The session is gone — /me now 404s with the old cookie.
    const me = await app.request("/admin/auth/me", {
      headers: { cookie: `${sessionCookieName()}=${cookie}` },
    });
    expect(me.status).toBe(404);
  });
});
