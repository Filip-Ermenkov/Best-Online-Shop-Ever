import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { products } from "./catalog";
import { users } from "./users";

/**
 * Server-side cart for logged-in customers. Per README §5, guests use
 * sessionStorage — those carts NEVER hit this table. On login we MERGE the
 * guest's session cart into the user's server cart (sum quantities for
 * duplicates).
 *
 * One cart per user — the user_id IS the primary key.
 */
export const carts = pgTable("carts", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`)
    .$onUpdate(() => new Date()),
});

/**
 * Cart line items. Only stores product_id + quantity — price is always read
 * fresh from products at render/checkout (README: "Кошницата винаги показва
 * актуалната текуща цена"). No price snapshot here.
 *
 * If a product is deleted, the line is cascade-deleted (the item is gone from
 * the catalog; nothing to render). The frontend already handles "out of stock"
 * by reading products.stock_status at fetch time.
 */
export const cartItems = pgTable(
  "cart_items",
  {
    cartUserId: uuid("cart_user_id")
      .notNull()
      .references(() => carts.userId, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    quantity: integer("quantity").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    primaryKey({ columns: [t.cartUserId, t.productId] }),
    index("cart_items_user_idx").on(t.cartUserId),
  ],
);
