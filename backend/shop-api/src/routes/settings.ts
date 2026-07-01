import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { schema } from "@shop/db";
import { getDb } from "../lib/db.js";
import { coerceSettings, pickPublic } from "../lib/settings.js";
import { validationHook } from "../lib/validation-hook.js";

/**
 * Public store settings (docs/README.md §"Настройки на магазина"). The anonymous,
 * edge-cacheable counterpart to the admin /admin/settings surface: it exposes
 * ONLY the customer-facing keys (address, hours, phone, email) — never the
 * operational ones (default pickup window, admin-notification recipient).
 *
 * Mirrors GET /categories and GET /banners: a read-only public GET with an ETag
 * + a 5-minute edge cache. Settings change rarely, so CloudFront absorbs almost
 * every read and the storefront footer / contact block costs no origin hit.
 *
 * camelCase DTO field names (not the snake_case registry keys) so the storefront
 * consumes them like every other DTO in this codebase.
 */

const PublicSettingsSchema = z
  .object({
    storeAddress: z.string(),
    storeHours: z.string(),
    /** Empty string = no phone configured (the storefront omits the line). */
    storePhone: z.string(),
    /** Empty string = no contact email configured. */
    storeEmail: z.string(),
  })
  .openapi("PublicSettings");

export type PublicSettingsDto = z.infer<typeof PublicSettingsSchema>;

const SHARED_CACHE_HEADERS = {
  // Same policy as GET /banners / GET /categories: 5 min at the edge, cheap
  // ETag revalidation (304) for browsers.
  "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=60",
  Vary: "Accept-Encoding",
};

const getRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["settings"],
  summary: "Public store settings (address, hours, contact phone + email)",
  description:
    "The customer-facing store configuration shown in the storefront footer / " +
    "contact block and on the order-tracking page. Cached for 5 minutes at the " +
    "edge. Operational settings (pickup window, admin notifications) are not " +
    "included — those are admin-only.",
  responses: {
    200: {
      description: "The public store settings.",
      content: { "application/json": { schema: PublicSettingsSchema } },
    },
  },
});

export const settingsRoutes = new OpenAPIHono({ defaultHook: validationHook });

settingsRoutes.openapi(getRoute, async (c) => {
  const db = getDb();
  const rows = await db
    .select({ key: schema.settings.key, value: schema.settings.value })
    .from(schema.settings);

  const pub = pickPublic(coerceSettings(rows));
  const body: PublicSettingsDto = {
    storeAddress: pub.store_address,
    storeHours: pub.store_hours,
    storePhone: pub.store_phone,
    storeEmail: pub.store_email,
  };
  return c.json(body, 200, SHARED_CACHE_HEADERS);
});
