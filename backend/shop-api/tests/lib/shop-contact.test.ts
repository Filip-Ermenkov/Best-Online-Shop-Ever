import { describe, expect, it } from "vitest";
import { coerceShopContact } from "../../src/lib/shop-contact.js";

/**
 * Unit tests for the shop-contact resolver (lib/shop-contact.ts) — the single
 * place the guest tracking page and the ready-for-pickup email get the store's
 * contact block from the admin-editable settings, with env/derived fallbacks.
 * The DB-fetching `loadShopContact` is exercised by the route/email tests; this
 * covers the pure resolution from already-fetched rows.
 */

describe("coerceShopContact", () => {
  it("returns configured settings verbatim", () => {
    const c = coerceShopContact([
      { key: "store_email", value: "info@duda1.bg" },
      { key: "store_phone", value: "+359 2 900 1234" },
      { key: "store_address", value: "ул. Витоша 15" },
      { key: "store_hours", value: "Пон-Пет: 9:00-18:00" },
    ]);
    expect(c).toEqual({
      email: "info@duda1.bg",
      phone: "+359 2 900 1234",
      address: "ул. Витоша 15",
      hours: "Пон-Пет: 9:00-18:00",
    });
  });

  it("falls back to a derived (non-empty) email when store_email is unset", () => {
    const c = coerceShopContact([]);
    // Email always resolves to something sendable (derived from EMAIL_FROM),
    // never empty — the caller can always render a contact line.
    expect(c.email.length).toBeGreaterThan(0);
    // Address/hours are blank when unset (the caller omits the lines).
    expect(c.address).toBe("");
    expect(c.hours).toBe("");
  });

  it("prefers the settings phone over any fallback", () => {
    const c = coerceShopContact([{ key: "store_phone", value: "+359 888 000 111" }]);
    expect(c.phone).toBe("+359 888 000 111");
  });
});
