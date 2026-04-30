/**
 * Re-exports every table and enum so consumers can do:
 *
 *   import { products, orders, orderStatusEnum } from "@shop/db/schema";
 *
 * Drizzle-kit also reads this file (per drizzle.config.ts `schema` field) to
 * discover all the schema objects it needs to track.
 */

export * from "./enums";
export * from "./users";
export * from "./catalog";
export * from "./cart";
export * from "./orders";
export * from "./auth";
export * from "./content";
export * from "./ops";
