import { schema } from "@shop/db";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { getDb } from "../../src/lib/db.js";

/**
 * Integration tests for the public banner read (routes/banners.ts): only active
 * slides, in display order, with the S3 key resolved to a URL and never exposed
 * raw — plus the empty-list (no hero) case and the ETag handshake. HTTP-level
 * via app.request(); fixtures seeded per test (per-test.ts truncated everything,
 * banner_slides included).
 */

let app: ReturnType<typeof buildApp>;

beforeAll(() => {
  app = buildApp();
});

async function insertBanner(opts: {
  imageS3Key: string;
  title?: string | null;
  subtitle?: string | null;
  linkUrl?: string | null;
  isActive?: boolean;
  displayOrder?: number;
}): Promise<string> {
  const db = getDb();
  const [row] = await db
    .insert(schema.bannerSlides)
    .values({
      imageS3Key: opts.imageS3Key,
      title: opts.title ?? null,
      subtitle: opts.subtitle ?? null,
      linkUrl: opts.linkUrl ?? null,
      isActive: opts.isActive ?? true,
      displayOrder: opts.displayOrder ?? 0,
    })
    .returning({ id: schema.bannerSlides.id });
  if (!row) throw new Error("banner seed failed");
  return row.id;
}

describe("GET /banners", () => {
  it("returns an empty list when there are no slides (no hero)", async () => {
    const res = await app.request("/banners");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/s-maxage=300/);
    expect(res.headers.get("vary")).toContain("Accept-Encoding");
    expect(await res.json()).toEqual({ items: [] });
  });

  it("returns only ACTIVE slides, in display order, with a resolved imageUrl", async () => {
    // Seed out of order, with one hidden slide that must NOT appear.
    await insertBanner({
      imageS3Key: "banners/c.jpg",
      title: "Трети",
      displayOrder: 2,
    });
    await insertBanner({
      imageS3Key: "banners/a.jpg",
      title: "Първи",
      linkUrl: "/products",
      displayOrder: 0,
    });
    await insertBanner({
      imageS3Key: "banners/hidden.jpg",
      title: "Скрит",
      isActive: false,
      displayOrder: 1,
    });
    await insertBanner({
      imageS3Key: "banners/b.jpg",
      title: "Втори",
      displayOrder: 1,
    });

    const res = await app.request("/banners");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        id: string;
        title: string | null;
        subtitle: string | null;
        imageUrl: string;
        linkUrl: string | null;
        displayOrder: number;
      }>;
    };

    // Hidden slide excluded; active ones ordered 0,1,2.
    expect(body.items.map((b) => b.title)).toEqual(["Първи", "Втори", "Трети"]);

    const first = body.items[0]!;
    // The raw S3 key is never exposed — only a derived URL.
    expect(first.imageUrl).toMatch(/^https?:\/\//);
    expect(first.imageUrl).not.toBe("banners/a.jpg");
    expect(first).toMatchObject({ linkUrl: "/products" });
    expect(first.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("supports the conditional-GET ETag handshake", async () => {
    await insertBanner({ imageS3Key: "banners/a.jpg", title: "А" });
    const first = await app.request("/banners");
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const second = await app.request("/banners", {
      headers: { "If-None-Match": etag! },
    });
    expect(second.status).toBe(304);
  });
});

describe("/openapi.json includes banners", () => {
  it("registers GET /banners with the BannerSlide component", async () => {
    const res = await app.request("/openapi.json");
    const spec = (await res.json()) as {
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };
    expect(spec.paths).toHaveProperty("/banners");
    expect(spec.components.schemas).toHaveProperty("BannerSlide");
  });
});
