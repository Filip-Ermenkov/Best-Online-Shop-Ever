import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { schema } from "@shop/db";
import { asc, eq } from "drizzle-orm";
import { getDb } from "../lib/db.js";
import { buildImageUrl } from "../lib/images.js";
import { validationHook } from "../lib/validation-hook.js";

/**
 * Public banner / hero-slider source data (docs/README.md §"Управление на
 * банер"). Mirrors GET /categories: an anonymous, edge-cacheable read that
 * returns ONLY the active slides in display order, with the stored S3 key
 * resolved to a public URL (raw keys never leave the API — see images.ts).
 *
 * The storefront home page renders these in the hero carousel. Per the spec,
 * "ако всички кадри са деактивирани или изтрити, банер секцията не се показва" —
 * so an empty `items` array is the signal to render no hero at all (the slider
 * returns null). Admin writes go through /admin/banners (requireAdmin); this
 * route is read-only and carries no `isActive=false` rows.
 */

// ─── Public DTO ────────────────────────────────────────────────────────────

const BannerSlideSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().nullable(),
    subtitle: z.string().nullable(),
    imageUrl: z.string().url(),
    /** Same-origin internal path only (validated at write time); null = no CTA. */
    linkUrl: z.string().nullable(),
    displayOrder: z.number().int(),
  })
  .openapi("BannerSlide");

const BannerListSchema = z
  .object({ items: z.array(BannerSlideSchema) })
  .openapi("BannerList");

/**
 * Concrete DTO types re-exported from `@shop/api` (src/types.ts) so the
 * storefront annotates its fetch helper with the exact shapes — the same
 * workspace-symlink-resilient convention as the catalog DTOs.
 */
export type BannerSlide = z.infer<typeof BannerSlideSchema>;
export type BannerList = z.infer<typeof BannerListSchema>;

const SHARED_CACHE_HEADERS = {
  // Banners change rarely (a promo swap now and then). CloudFront holds for 5
  // minutes; browsers revalidate cheaply via the ETag handshake (304). Same
  // policy as GET /categories.
  "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=60",
  Vary: "Accept-Encoding",
};

// ─── Route ───────────────────────────────────────────────────────────────────

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["banners"],
  summary: "Active promotional banner slides for the homepage hero",
  description:
    "Returns the active banner slides in display order. An empty list means " +
    "the homepage renders no hero section (every slide is hidden or none " +
    "exist). Cached for 5 minutes at the edge.",
  responses: {
    200: {
      description: "Active slides in display order.",
      content: { "application/json": { schema: BannerListSchema } },
    },
  },
});

export const bannersRoutes = new OpenAPIHono({ defaultHook: validationHook });

bannersRoutes.openapi(listRoute, async (c) => {
  const db = getDb();
  const rows = await db
    .select({
      id: schema.bannerSlides.id,
      title: schema.bannerSlides.title,
      subtitle: schema.bannerSlides.subtitle,
      imageS3Key: schema.bannerSlides.imageS3Key,
      linkUrl: schema.bannerSlides.linkUrl,
      displayOrder: schema.bannerSlides.displayOrder,
    })
    .from(schema.bannerSlides)
    .where(eq(schema.bannerSlides.isActive, true))
    .orderBy(
      asc(schema.bannerSlides.displayOrder),
      asc(schema.bannerSlides.createdAt),
    );

  const items: BannerSlide[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    subtitle: r.subtitle,
    imageUrl: buildImageUrl(r.imageS3Key),
    linkUrl: r.linkUrl,
    displayOrder: r.displayOrder,
  }));

  return c.json({ items }, 200, SHARED_CACHE_HEADERS);
});
