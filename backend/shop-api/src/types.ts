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
