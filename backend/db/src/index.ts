/**
 * Public package entry. Consumers (the future Lambda functions, or the Next.js
 * server actions) import from here:
 *
 *   import { createDb, schema } from "@shop/db";
 *
 * For schema-only imports (e.g. type-level usage, no client needed):
 *
 *   import { products, type orderStatusEnum } from "@shop/db/schema";
 */

export * from "./client";
export * as schema from "./schema/index";
