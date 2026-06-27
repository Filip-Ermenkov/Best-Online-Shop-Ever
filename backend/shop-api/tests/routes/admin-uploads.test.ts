import { hashPassword } from "@shop/auth";
import { schema } from "@shop/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { sessionCookieName } from "../../src/lib/cookies.js";
import { getDb } from "../../src/lib/db.js";
import { _resetEnvForTests } from "../../src/lib/env.js";
import { createSession } from "../../src/lib/sessions.js";
import {
  _resetUploadAdaptersForTests,
  _setUploadAdaptersForTests,
  type PresignedPost,
} from "../../src/routes/admin/uploads.js";
import type { PresignedPostParams } from "../../src/lib/asset-upload.js";

/**
 * Integration tests for the admin image-upload presign route
 * (routes/admin/uploads.ts): the requireAdmin gate, request validation
 * (allowlist + size cap + kind), the presigned-POST response shape, the 503
 * when no bucket is configured, and the status poll. The S3 adapters are
 * injected (no AWS / network); the REAL presign policy is proven by the pure
 * `asset-upload` unit suite + an offline createPresignedPost check.
 */

let app: ReturnType<typeof buildApp>;
const PASSWORD = "correct horse battery staple";
const BUCKET = "shop-test-assets";

/** Records the params the route handed to the presigner so we can assert them. */
let lastPresignParams: PresignedPostParams | null = null;

const fakePresign = async (params: PresignedPostParams): Promise<PresignedPost> => {
  lastPresignParams = params;
  return {
    url: `https://${params.Bucket}.s3.eu-central-1.amazonaws.com/`,
    fields: {
      key: params.Key,
      "Content-Type": params.Fields["Content-Type"]!,
      Policy: "BASE64POLICY",
      "X-Amz-Signature": "deadbeef",
    },
  };
};

/** Pretend only keys ending in "-ready.jpg" have been validated + promoted. */
const fakeObjectExists = async (_bucket: string, key: string): Promise<boolean> =>
  key.includes("-ready.");

function setBucket(value: string): void {
  process.env.ASSET_UPLOAD_BUCKET = value;
  _resetEnvForTests();
}

function cookieHeader(token: string): string {
  return `${sessionCookieName()}=${token}`;
}

async function seedAdminSession(email = "admin@shop.bg"): Promise<string> {
  const db = getDb();
  const [user] = await db
    .insert(schema.users)
    .values({
      email: email.toLowerCase(),
      passwordHash: await hashPassword(PASSWORD),
      role: "admin",
      accountType: null,
      emailVerifiedAt: new Date(),
      mfaEnabled: true,
    })
    .returning();
  if (!user) throw new Error("admin seed failed");
  const { token } = await createSession({
    userId: user.id,
    rememberMe: false,
    role: "admin",
    ipAddress: null,
    userAgent: null,
  });
  return cookieHeader(token);
}

async function seedCustomerSession(email = "ivan@example.com"): Promise<string> {
  const db = getDb();
  const [user] = await db
    .insert(schema.users)
    .values({
      email: email.toLowerCase(),
      passwordHash: await hashPassword(PASSWORD),
      role: "customer",
      accountType: "personal",
      emailVerifiedAt: new Date(),
    })
    .returning();
  if (!user) throw new Error("customer seed failed");
  const { token } = await createSession({
    userId: user.id,
    rememberMe: false,
    role: "customer",
    ipAddress: null,
    userAgent: null,
  });
  return cookieHeader(token);
}

async function postUpload(body: unknown, cookie?: string): Promise<Response> {
  return app.request("/admin/uploads", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeAll(() => {
  app = buildApp();
});

beforeEach(() => {
  lastPresignParams = null;
  _setUploadAdaptersForTests({
    presignPost: fakePresign,
    objectExists: fakeObjectExists,
  });
  setBucket(BUCKET);
});

afterEach(() => {
  _resetUploadAdaptersForTests();
});

afterAll(() => {
  delete process.env.ASSET_UPLOAD_BUCKET;
  _resetEnvForTests();
});

describe("POST /admin/uploads — requireAdmin gate", () => {
  it("returns a uniform 404 with no session", async () => {
    const res = await postUpload({
      kind: "products",
      contentType: "image/jpeg",
      contentLength: 1024,
    });
    expect(res.status).toBe(404);
  });

  it("returns a uniform 404 for a customer session", async () => {
    const cookie = await seedCustomerSession();
    const res = await postUpload(
      { kind: "products", contentType: "image/jpeg", contentLength: 1024 },
      cookie,
    );
    expect(res.status).toBe(404);
  });
});

describe("POST /admin/uploads — minting", () => {
  it("mints a presigned POST and returns the key to store", async () => {
    const cookie = await seedAdminSession();
    const res = await postUpload(
      { kind: "products", contentType: "image/jpeg", contentLength: 204_800 },
      cookie,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      url: string;
      method: string;
      fields: Record<string, string>;
      storedKey: string;
      publicUrl: string;
      expiresInSeconds: number;
    };
    expect(body.method).toBe("POST");
    expect(body.url).toContain(BUCKET);
    expect(body.storedKey).toMatch(/^products\/[0-9a-f-]{36}\.jpg$/);
    expect(body.fields["Content-Type"]).toBe("image/jpeg");
    expect(body.fields.key).toMatch(/^pending\/products\/[0-9a-f-]{36}\.jpg$/);
    expect(body.expiresInSeconds).toBeGreaterThan(0);

    // The route pinned the size cap into the policy it asked the signer for.
    expect(lastPresignParams?.Bucket).toBe(BUCKET);
    expect(lastPresignParams?.Key).toBe(body.fields.key);
    expect(lastPresignParams?.Conditions).toContainEqual([
      "content-length-range",
      1,
      10 * 1024 * 1024,
    ]);
  });

  it("routes each kind to its own key folder", async () => {
    const cookie = await seedAdminSession();
    for (const kind of ["products", "categories", "banners"] as const) {
      const res = await postUpload(
        { kind, contentType: "image/webp", contentLength: 1000 },
        cookie,
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as { storedKey: string };
      expect(body.storedKey).toMatch(new RegExp(`^${kind}/[0-9a-f-]{36}\\.webp$`));
    }
  });

  it("rejects a disallowed content type (svg) with a field error", async () => {
    const cookie = await seedAdminSession();
    const res = await postUpload(
      { kind: "products", contentType: "image/svg+xml", contentLength: 1000 },
      cookie,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors?: { path: string }[] };
    expect(body.errors?.[0]?.path).toBe("contentType");
  });

  it("rejects an over-cap file with a field error", async () => {
    const cookie = await seedAdminSession();
    const res = await postUpload(
      {
        kind: "products",
        contentType: "image/jpeg",
        contentLength: 10 * 1024 * 1024 + 1,
      },
      cookie,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors?: { path: string }[] };
    expect(body.errors?.[0]?.path).toBe("contentLength");
  });

  it("rejects an unknown kind at schema validation", async () => {
    const cookie = await seedAdminSession();
    const res = await postUpload(
      { kind: "invoices", contentType: "image/jpeg", contentLength: 1000 },
      cookie,
    );
    expect(res.status).toBe(400);
  });

  it("returns 503 when no asset bucket is configured", async () => {
    const cookie = await seedAdminSession();
    setBucket("");
    const res = await postUpload(
      { kind: "products", contentType: "image/jpeg", contentLength: 1000 },
      cookie,
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { type: string };
    expect(body.type).toBe("/problems/uploads-not-configured");
  });
});

describe("GET /admin/uploads/status", () => {
  it("reports a not-yet-promoted key as not ready", async () => {
    const cookie = await seedAdminSession();
    const res = await app.request(
      "/admin/uploads/status?key=products/11111111-2222-4333-8444-555555555555.jpg",
      { headers: { Cookie: cookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ready: boolean };
    expect(body.ready).toBe(false);
  });

  it("accepts a well-formed key and honours the existence check", async () => {
    const cookie = await seedAdminSession();
    // Inject an existence check keyed on the prefix so a valid UUID key resolves.
    _setUploadAdaptersForTests({
      presignPost: fakePresign,
      objectExists: async () => true,
    });
    const res = await app.request(
      "/admin/uploads/status?key=categories/11111111-2222-4333-8444-555555555555.png",
      { headers: { Cookie: cookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { key: string; ready: boolean };
    expect(body.key).toBe("categories/11111111-2222-4333-8444-555555555555.png");
    expect(body.ready).toBe(true);
  });

  it("rejects a malformed key", async () => {
    const cookie = await seedAdminSession();
    const res = await app.request("/admin/uploads/status?key=not-a-key", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(400);
  });

  it("requires an admin session", async () => {
    const res = await app.request(
      "/admin/uploads/status?key=products/11111111-2222-4333-8444-555555555555.jpg",
    );
    expect(res.status).toBe(404);
  });
});
