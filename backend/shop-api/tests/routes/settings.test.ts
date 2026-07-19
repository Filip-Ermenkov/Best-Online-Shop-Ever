import { schema } from "@shop/db";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { getDb } from "../../src/lib/db.js";

/**
 * Integration tests for the public store-settings read (routes/settings.ts):
 * only the customer-facing keys, camelCase DTO, defaults when unset, never
 * leaking the operational (admin-only) keys — plus the ETag handshake. HTTP-level
 * via app.request(); per-test.ts truncates `settings` between tests, so each
 * test seeds its own rows.
 */

let app: ReturnType<typeof buildApp>;

beforeAll(() => {
  app = buildApp();
});

async function setSetting(key: string, value: unknown): Promise<void> {
  const db = getDb();
  await db
    .insert(schema.settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value } });
}

describe("GET /settings (public)", () => {
  it("returns empty-string defaults when nothing is configured", async () => {
    const res = await app.request("/settings");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/s-maxage=300/);
    expect(res.headers.get("vary")).toContain("Accept-Encoding");
    expect(await res.json()).toEqual({
      storeAddress: "",
      storeHours: "",
      storePhone: "",
      storeEmail: "",
    });
  });

  it("returns the public values as camelCase and never leaks private keys", async () => {
    await setSetting("store_address", "ул. Витоша 15, София 1000");
    await setSetting("store_hours", "Пон-Пет: 9:00-18:00");
    await setSetting("store_phone", "+359 2 900 1234");
    await setSetting("store_email", "info@duda1.shop");
    // Private/operational keys that MUST NOT appear in the public response.
    await setSetting("default_pickup_deadline_days", 7);
    await setSetting("admin_notification_email", "ops@duda1.shop");

    const res = await app.request("/settings");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toEqual({
      storeAddress: "ул. Витоша 15, София 1000",
      storeHours: "Пон-Пет: 9:00-18:00",
      storePhone: "+359 2 900 1234",
      storeEmail: "info@duda1.shop",
    });
    // No operational keys leak under any spelling.
    expect("default_pickup_deadline_days" in body).toBe(false);
    expect("admin_notification_email" in body).toBe(false);
    expect("adminNotificationEmail" in body).toBe(false);
  });

  it("supports the conditional-GET ETag handshake", async () => {
    await setSetting("store_phone", "+359 2 900 1234");
    const first = await app.request("/settings");
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const second = await app.request("/settings", {
      headers: { "If-None-Match": etag! },
    });
    expect(second.status).toBe(304);
  });
});

describe("/openapi.json includes settings", () => {
  it("registers GET /settings with the PublicSettings component", async () => {
    const res = await app.request("/openapi.json");
    const spec = (await res.json()) as {
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };
    expect(spec.paths).toHaveProperty("/settings");
    expect(spec.components.schemas).toHaveProperty("PublicSettings");
  });
});
