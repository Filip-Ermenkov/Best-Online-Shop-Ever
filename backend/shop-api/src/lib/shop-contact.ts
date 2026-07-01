import { schema } from "@shop/db";
import type { getDb } from "./db.js";
import { parseEnv } from "./env.js";
import { coerceSettings } from "./settings.js";
import { deriveSupportEmail } from "./withdrawal.js";

/**
 * Resolve the shop's public contact block from the admin-editable `settings`
 * table, with environment-variable / derived fallbacks (docs/README.md
 * §"Настройки на магазина"). One place so the guest tracking page and the
 * order-status emails surface identical contact details.
 *
 * Fallback order (per field):
 *   - email   : settings.store_email → derived from EMAIL_FROM (always non-empty)
 *   - phone   : settings.store_phone → SHOP_CONTACT_PHONE env → null
 *   - address : settings.store_address → "" (caller omits when empty)
 *   - hours   : settings.store_hours  → "" (caller omits when empty)
 *
 * This is the read counterpart to the public GET /settings the storefront uses;
 * the backend consumers (which already hold a `db`) read straight from the table
 * instead of round-tripping their own API.
 */
export interface ShopContact {
  email: string;
  phone: string | null;
  address: string;
  hours: string;
}

/**
 * Resolve from already-fetched settings rows — no DB I/O, so a caller that
 * already loads the `settings` rows in a parallel query (e.g. the guest tracking
 * page) reuses them instead of issuing a second read.
 */
export function coerceShopContact(
  rows: ReadonlyArray<{ key: string; value: unknown }>,
): ShopContact {
  const s = coerceSettings(rows);
  const env = parseEnv();
  const phone = s.store_phone || env.SHOP_CONTACT_PHONE;
  return {
    email: s.store_email || deriveSupportEmail(env.EMAIL_FROM),
    phone: phone.length > 0 ? phone : null,
    address: s.store_address,
    hours: s.store_hours,
  };
}

/** Fetch the settings rows and resolve. For callers that hold a `db` only. */
export async function loadShopContact(
  db: ReturnType<typeof getDb>,
): Promise<ShopContact> {
  const rows = await db
    .select({ key: schema.settings.key, value: schema.settings.value })
    .from(schema.settings);
  return coerceShopContact(rows);
}
