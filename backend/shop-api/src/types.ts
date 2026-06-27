/**
 * Public type surface — what consumers (the frontend, future internal tools)
 * import from "@shop/api".
 *
 * Two layers:
 *
 *   1. **AppType** — the lynchpin of Hono RPC. Pass it to
 *      `hc<AppType>(baseUrl)` and you get a fully typed client where:
 *
 *        const res = await client.products.$get({ query: { sort: "newest" } });
 *        // res.json() is strongly typed as ProductsPage.
 *
 *      `AppType` is `ReturnType<typeof buildApp>` — that's a deep type
 *      derivation that walks every route file, every Zod schema, every
 *      workspace dep. It generally works, but is brittle under workspace-
 *      symlink quirks: any link that degrades to `any` collapses the whole
 *      RPC type into untyped responses.
 *
 *   2. **Concrete DTOs** — `ProductSummary`, `ProductsPage`, `CategoryTree`,
 *      etc. These come from `z.infer<typeof XSchema>` of the actual Zod
 *      schemas in `routes/*.ts`. They're shallow types: only `zod` and the
 *      one route file participate, no transitive workspace resolution. The
 *      frontend uses these to annotate `lib/api.ts` helpers (`fetchProducts`,
 *      `fetchCategoryTree`, ...) so callers always get the right shape
 *      regardless of how `AppType` resolves on their machine.
 *
 * Crucially, NO runtime code from shop-api is shipped to the consumer — only
 * the type information. Tree shaking strips this file out of the consumer's
 * bundle.
 */
import type { buildApp } from "./app.js";

export type AppType = ReturnType<typeof buildApp>;

// Concrete product DTOs from the Zod schemas in routes/products.ts.
export type {
  ProductImage,
  StockStatus,
  ProductSummary,
  CategoryBreadcrumb,
  ProductDetail,
  ProductsPage,
} from "./routes/products.js";

// Concrete category DTOs from routes/categories.ts. `CategoryNode` is the
// recursive node shape (manually annotated so Zod's `z.lazy()` can type-
// check); `CategoryTree` is the envelope.
export type { CategoryNode, CategoryTree } from "./routes/categories.js";

// GDPR Art. 15 + Art. 20 self-service personal-data export envelope. The Zod
// schema + builder live in lib/data-export.ts (the route in routes/auth.ts
// references the schema for OpenAPI). Exported here as a concrete DTO for any
// internal consumer that wants the typed shape.
export type { DataExport } from "./lib/data-export.js";

// Customer address-book DTO from routes/addresses.ts. The frontend annotates
// its lib/addresses fetch helpers with this concrete shape so callers get the
// right type regardless of how the workspace symlink resolves AppType.
export type { Address } from "./routes/addresses.js";

// Cookie-consent receipt DTOs from routes/consent.ts. The frontend annotates
// its lib/consent client with these concrete shapes (GDPR Art. 7 server-side
// consent receipts), independent of how the workspace symlink resolves AppType.
export type {
  ConsentCategory,
  ConsentReceipt,
  ConsentState,
} from "./routes/consent.js";

// Admin order-management DTOs from routes/admin/orders.ts. The admin frontend
// (frontend/src/lib/admin/orders/) annotates its typed client with these.
export type {
  AdminOrderSummary,
  AdminOrdersPage,
  AdminOrderDetail,
  AdminOrderStatusHistoryEntry,
} from "./routes/admin/orders.js";

// The pure order-status state machine (docs/README.md §7). `allowedTargets`
// arrives on every AdminOrderDetail, so the frontend never re-derives the
// table — but the types travel with it.
export type { OrderStatus, TransitionTarget } from "./lib/order-status.js";

// Admin category-management DTOs from routes/admin/categories.ts. The admin
// frontend (frontend/src/lib/admin/categories/) annotates its typed client
// with these concrete shapes, independent of how the workspace symlink
// resolves AppType.
export type {
  AdminCategoryNode,
  AdminCategoryTree,
  AdminCategoryDeletionImpact,
} from "./routes/admin/categories.js";

// Admin product-management DTOs from routes/admin/products.ts. The admin
// frontend (frontend/src/lib/admin/products/) will annotate its typed client
// with these concrete shapes, independent of how the workspace symlink resolves
// AppType.
export type {
  AdminProductSummary,
  AdminProductDetail,
  AdminProductList,
} from "./routes/admin/products.js";

// Admin image-upload DTOs from routes/admin/uploads.js (roadmap item 46). The
// admin frontend's upload client (frontend/src/lib/uploads/) annotates its typed
// helpers with these: `AdminPresignedUpload` is the presign response (POST target
// + fields + the storedKey to save on the entity); `AdminUploadStatus` is the
// validate-and-promote poll. Single image pipeline for products/categories/banners.
export type {
  AdminPresignedUpload,
  AdminUploadStatus,
} from "./routes/admin/uploads.js";

// Guest checkout + order-tracking DTOs from routes/guest.ts (the spec's "Гост"
// role). The storefront annotates its lib/track + guest-checkout clients with
// these concrete shapes, independent of how the workspace symlink resolves
// AppType.
export type {
  GuestOrder,
  TrackedOrder,
  TrackOrderItem,
  TrackWithdrawalEligibility,
  TrackWithdrawalRecord,
} from "./routes/guest.js";

// SEO / crawlability DTOs from routes/seo.ts. The storefront's app/sitemap.ts
// and the catch-all's redirect-serving client annotate their fetch helpers with
// these concrete shapes, independent of how the workspace symlink resolves
// AppType. `SitemapResponse` = canonical paths + lastmod for the live catalog;
// `RedirectResolution` = the final 301 target for a deleted URL.
export type { RedirectResolution, SitemapResponse } from "./routes/seo.js";
