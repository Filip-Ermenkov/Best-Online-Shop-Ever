/**
 * Public type surface — what consumers (the frontend, future internal tools)
 * import from "@shop/api".
 *
 * The AppType is the lynchpin of Hono RPC: pass it to `hc<AppType>(baseUrl)`
 * and you get a fully typed client where:
 *
 *   const res = await client.products.$get({ query: { sort: "newest" } });
 *   // res.json() is strongly typed as ProductsPage.
 *
 * Crucially, NO runtime code from shop-api is shipped to the consumer — only
 * the type. Tree shaking strips this file out of the consumer's bundle.
 */
import type { buildApp } from "./app.js";

export type AppType = ReturnType<typeof buildApp>;
