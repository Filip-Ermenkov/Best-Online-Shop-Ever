import { schema } from "@shop/db";
import { desc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { visitorCookieName } from "../../src/lib/cookies.js";
import { getDb } from "../../src/lib/db.js";
import { CONSENT_POLICY_VERSION } from "../../src/routes/consent.js";

/**
 * Integration tests for the server-side cookie-consent receipts.
 *
 * Routes under test (anonymous — no auth chain, like /csp-report):
 *   - POST /consent   record this visitor's choice (append-only); mints + sets
 *                     the opaque `visitor_id` cookie on first call, reuses it after
 *   - GET  /consent   return the visitor's CURRENT (latest) receipt, or null
 *
 * The whole point of the slice (GDPR Art. 7(1) demonstrability) is that the
 * record lives server-side and the controller can produce it on demand — so the
 * tests assert the durable row + the receipt, the append-only history, the
 * stable visitor key, and that a read never mints an identifier.
 */

let app: ReturnType<typeof buildApp>;

beforeAll(() => {
  app = buildApp();
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Pull the visitor-id value out of a Set-Cookie header (or null if absent). */
function extractVisitorCookie(setCookie: string | null): string | null {
  if (!setCookie) return null;
  const name = visitorCookieName();
  const match = setCookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match?.[1] ?? null;
}

function jsonHeaders(): Record<string, string> {
  return { "Content-Type": "application/json" };
}

/** Headers that carry an existing visitor cookie back to the server. */
function withVisitor(vid: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Cookie: `${visitorCookieName()}=${vid}`,
  };
}

async function record(
  acceptedCategories: string[],
  vid?: string,
): Promise<Response> {
  return app.request("/consent", {
    method: "POST",
    headers: vid ? withVisitor(vid) : jsonHeaders(),
    body: JSON.stringify({ acceptedCategories }),
  });
}

describe("POST /consent — recording a choice", () => {
  it("records a receipt, mints a visitor cookie, and returns the receipt (201)", async () => {
    const res = await record(["analytics"]);
    expect(res.status).toBe(201);

    const body = (await res.json()) as {
      id: string;
      acceptedCategories: string[];
      policyVersion: string;
      recordedAt: string;
    };
    expect(body.id).toMatch(UUID_RE);
    expect(body.acceptedCategories).toEqual(["analytics"]);
    expect(body.policyVersion).toBe(CONSENT_POLICY_VERSION);
    // ISO-8601 with timezone — round-trips through Date without NaN.
    expect(Number.isNaN(Date.parse(body.recordedAt))).toBe(false);

    // A strictly-necessary visitor cookie is set on the first write.
    const vid = extractVisitorCookie(res.headers.get("set-cookie"));
    expect(vid).toBeTruthy();

    // The durable row exists and is keyed on that visitor id.
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.cookieConsents)
      .where(eq(schema.cookieConsents.visitorId, vid!));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.acceptedCategories).toEqual(["analytics"]);
  });

  it("normalises categories: de-duplicates and sorts deterministically", async () => {
    const res = await record(["marketing", "analytics", "analytics"]);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { acceptedCategories: string[] };
    expect(body.acceptedCategories).toEqual(["analytics", "marketing"]);
  });

  it("accepts an empty array as a valid 'reject all' (only essential)", async () => {
    const res = await record([]);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { acceptedCategories: string[] };
    expect(body.acceptedCategories).toEqual([]);
  });

  it("reuses the visitor id on a second write (no new cookie, shared key)", async () => {
    const first = await record(["analytics"]);
    const vid = extractVisitorCookie(first.headers.get("set-cookie"));
    expect(vid).toBeTruthy();

    const second = await record(["marketing"], vid!);
    expect(second.status).toBe(201);
    // A returning browser keeps its id — the server must NOT re-issue one.
    expect(extractVisitorCookie(second.headers.get("set-cookie"))).toBeNull();

    // Append-only: two rows, both under the one visitor key.
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.cookieConsents)
      .where(eq(schema.cookieConsents.visitorId, vid!));
    expect(rows).toHaveLength(2);
  });
});

describe("POST /consent — validation gates", () => {
  it("rejects an unknown category (400)", async () => {
    const res = await record(["tracking"]);
    expect(res.status).toBe(400);
  });

  it("rejects unknown fields via .strict() (400)", async () => {
    const res = await app.request("/consent", {
      method: "POST",
      headers: jsonHeaders(),
      // A confused client must not be able to smuggle visitorId/recordedAt.
      body: JSON.stringify({ acceptedCategories: [], visitorId: "spoofed" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a missing acceptedCategories field (400)", async () => {
    const res = await app.request("/consent", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /consent — current state", () => {
  it("returns { consent: null } when this browser has no cookie", async () => {
    const res = await app.request("/consent", { method: "GET" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ consent: null });
    // A read must NOT mint an identifier.
    expect(extractVisitorCookie(res.headers.get("set-cookie"))).toBeNull();
  });

  it("returns the latest receipt for a visitor with history (append-only)", async () => {
    // Two writes under one browser; GET must surface the most recent.
    const first = await record(["analytics"]);
    const vid = extractVisitorCookie(first.headers.get("set-cookie"))!;
    await record(["analytics", "marketing"], vid);

    const res = await app.request("/consent", {
      method: "GET",
      headers: { Cookie: `${visitorCookieName()}=${vid}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      consent: { acceptedCategories: string[]; policyVersion: string } | null;
    };
    expect(body.consent).not.toBeNull();
    expect(body.consent?.acceptedCategories).toEqual(["analytics", "marketing"]);
    expect(body.consent?.policyVersion).toBe(CONSENT_POLICY_VERSION);

    // Sanity: the latest row by recordedAt matches what GET returned.
    const db = getDb();
    const [latest] = await db
      .select()
      .from(schema.cookieConsents)
      .where(eq(schema.cookieConsents.visitorId, vid))
      .orderBy(desc(schema.cookieConsents.recordedAt))
      .limit(1);
    expect(latest?.acceptedCategories).toEqual(["analytics", "marketing"]);
  });

  it("returns null for a cookie that has no rows on record", async () => {
    const res = await app.request("/consent", {
      method: "GET",
      headers: { Cookie: `${visitorCookieName()}=never-recorded` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ consent: null });
  });
});
