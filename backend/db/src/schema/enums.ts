import { pgEnum } from "drizzle-orm/pg-core";

/**
 * Native Postgres enums — preferred over CHECK constraints because:
 *  - Type-safe at the DB layer
 *  - Shows up in psql / pgAdmin meaningfully
 *  - Enforces ordering for sort if ever needed
 *
 * Adding a value later: `ALTER TYPE … ADD VALUE 'x';` — does NOT block in PG ≥ 12.
 * Removing a value: cannot be done in-place; requires recreate-and-cast (rare).
 */

export const userRoleEnum = pgEnum("user_role", ["admin", "customer"]);

export const accountTypeEnum = pgEnum("account_type", ["personal", "corporate"]);

export const stockStatusEnum = pgEnum("stock_status", ["in_stock", "out_of_stock"]);

export const paymentMethodEnum = pgEnum("payment_method", [
  "pay_at_store",
  "cash_on_delivery",
]);

/**
 * Order lifecycle. See docs/README.md §7 for the state machine.
 *  processing       → initial status when an order is placed
 *  shipped          → courier delivery only; admin sets when handing to courier
 *  ready_for_pickup → pay_at_store only; admin sets when order is prepared
 *  delivered        → courier delivered to customer
 *  accepted         → terminal; customer received the order (delivered → accepted, or pickup taken)
 *  returned         → terminal; customer refused / returned
 *  cancelled        → terminal; admin or customer cancelled
 */
export const orderStatusEnum = pgEnum("order_status", [
  "processing",
  "shipped",
  "ready_for_pickup",
  "delivered",
  "accepted",
  "returned",
  "cancelled",
]);

export const verificationTokenKindEnum = pgEnum("verification_token_kind", [
  "signup",
  "email_change",
]);

export const cookieConsentCategoryEnum = pgEnum("cookie_consent_category", [
  "analytics",
  "marketing",
]);

/** Where a 301 should land when its source resource was deleted. */
export const redirectTargetKindEnum = pgEnum("redirect_target_kind", [
  "category",
  "product",
  "home",
]);

export const catalogBackupKindEnum = pgEnum("catalog_backup_kind", [
  "manual",
  "scheduled",
]);

export const complaintReasonEnum = pgEnum("complaint_reason", [
  "defective",
  "wrong_item",
  "withdrawal", // 14-day right of withdrawal under EU Directive 2011/83/EU
  "other",
]);
