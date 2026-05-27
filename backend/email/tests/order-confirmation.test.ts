import { describe, expect, it } from "vitest";
import {
  renderOrderConfirmationEmail,
  ORDER_CONFIRMATION_TEMPLATE_ID,
} from "../src/templates/order-confirmation.js";

/**
 * Pin time so the formatted-timestamp assertion is deterministic across
 * CI / local. 12 May 2026, 14:23:07 UTC → Europe/Sofia is UTC+3 in May
 * (EEST, daylight savings) → 17:23:07 local. Matches the convention used
 * by the withdrawal-received tests.
 */
const PLACED_AT = new Date("2026-05-12T14:23:07Z");

const SAMPLE_ITEMS = [
  {
    productCode: "SKU-001",
    productName: "Тестова стока А",
    quantity: 2,
    unitPriceCents: 1999,
  },
  {
    productCode: "SKU-002",
    productName: "Тестова стока Б",
    quantity: 1,
    unitPriceCents: 599,
  },
];

describe("renderOrderConfirmationEmail", () => {
  it("produces an OutgoingEmail with the full order summary", () => {
    const out = renderOrderConfirmationEmail({
      to: "customer@example.com",
      fullName: "Иван Петров",
      orderNumber: "2026-05-00042",
      placedAt: PLACED_AT,
      paymentMethod: "cash_on_delivery",
      items: SAMPLE_ITEMS,
      subtotalCents: 4597,
      discountPercent: 0,
      discountAmountCents: 0,
      totalCents: 4597,
      deliveryAddress: {
        city: "София",
        postalCode: "1000",
        street: "ул. Витоша 1",
        apartmentOrOffice: "ап. 5",
      },
      orderUrl: "https://example.com/account/orders/2026-05-00042",
      shopName: "Магазина",
      supportEmail: "support@example.com",
    });

    expect(out.to).toBe("customer@example.com");
    expect(out.subject).toBe("Поръчка 2026-05-00042 — потвърждение");
    expect(out.templateId).toBe(ORDER_CONFIRMATION_TEMPLATE_ID);

    expect(out.text).toContain("Иван Петров");
    expect(out.html).toContain("Иван Петров");

    expect(out.text).toContain("2026-05-00042");
    expect(out.html).toContain("2026-05-00042");

    expect(out.text).toContain("чл. 50");
    expect(out.text).toContain("2023/2673");
    expect(out.text).toContain("дълготраен носител");
    expect(out.html).toContain("дълготраен носител");

    expect(out.text).toMatch(/17:23/);
    expect(out.html).toMatch(/17:23/);
    expect(out.text).toContain("Европа/София");
    expect(out.html).toContain("Европа/София");

    expect(out.text).toContain("Тестова стока А");
    expect(out.text).toContain("Тестова стока Б");
    expect(out.text).toContain("SKU-001");
    expect(out.text).toContain("SKU-002");
    expect(out.text).toMatch(/39[,.]98/);
    expect(out.html).toMatch(/39[,.]98/);

    // Totals are present. The plaintext body uppercases "ОБЩА СУМА" for
    // emphasis (no HTML weight available in the text fallback); the HTML
    // body uses sentence case "Обща сума:". Assert each variant on the
    // surface that produces it.
    expect(out.text).toContain("Междинна сума");
    expect(out.text).toMatch(/45[,.]97/);
    expect(out.text).toContain("ОБЩА СУМА");
    expect(out.html).toContain("Обща сума");

    expect(out.text).toContain("ул. Витоша 1");
    expect(out.text).toContain("ап. 5");
    expect(out.text).toContain("1000");
    expect(out.text).toContain("София");

    expect(out.text).toContain("Наложен платеж");

    expect(out.text.toLowerCase()).toContain("право на отказ");
    expect(out.text).toContain("14");

    expect(out.text).toContain("support@example.com");
    expect(out.html).toContain("support@example.com");

    expect(out.html).toContain("https://example.com/account/orders/2026-05-00042");
    expect(out.text).toContain("https://example.com/account/orders/2026-05-00042");

    expect(out.text.toLowerCase()).not.toContain("сигурни ли сте");
    expect(out.text.toLowerCase()).not.toContain("препоръчваме");
  });

  it("renders pickup messaging for pay_at_store and omits delivery address", () => {
    const out = renderOrderConfirmationEmail({
      to: "customer@example.com",
      orderNumber: "2026-05-00043",
      placedAt: PLACED_AT,
      paymentMethod: "pay_at_store",
      items: SAMPLE_ITEMS,
      subtotalCents: 4597,
      discountPercent: 0,
      discountAmountCents: 0,
      totalCents: 4597,
    });

    expect(out.text).toContain("Получаване");
    expect(out.text).toContain("в магазина");
    expect(out.text).toContain("Плащане в магазина");

    expect(out.text).not.toContain("Адрес за доставка");
    expect(out.html).not.toContain("Адрес за доставка");
  });

  it("renders a discount row when discountAmountCents > 0", () => {
    const out = renderOrderConfirmationEmail({
      to: "customer@example.com",
      orderNumber: "2026-05-00044",
      placedAt: PLACED_AT,
      paymentMethod: "pay_at_store",
      items: [SAMPLE_ITEMS[0]!],
      subtotalCents: 3998,
      discountPercent: 10,
      discountAmountCents: 399,
      totalCents: 3599,
    });

    expect(out.text).toContain("Отстъпка");
    expect(out.text).toMatch(/10/);
    expect(out.text).toMatch(/3[,.]99/);
    expect(out.html).toContain("Отстъпка");
  });

  it("falls back to a generic salutation when fullName is missing", () => {
    const out = renderOrderConfirmationEmail({
      to: "anon@example.com",
      orderNumber: "2026-05-00007",
      placedAt: PLACED_AT,
      paymentMethod: "pay_at_store",
      items: SAMPLE_ITEMS,
      subtotalCents: 4597,
      discountPercent: 0,
      discountAmountCents: 0,
      totalCents: 4597,
    });
    expect(out.text.startsWith("Здравейте!\n")).toBe(true);
    expect(out.html).toContain("Здравейте!");
  });

  it("HTML-escapes injection-prone fields", () => {
    const evil = `</td><script>alert(1)</script>`;
    const out = renderOrderConfirmationEmail({
      to: "x@example.com",
      fullName: evil,
      orderNumber: evil,
      placedAt: PLACED_AT,
      paymentMethod: "cash_on_delivery",
      items: [
        {
          productCode: evil,
          productName: evil,
          quantity: 1,
          unitPriceCents: 100,
        },
      ],
      subtotalCents: 100,
      discountPercent: 0,
      discountAmountCents: 0,
      totalCents: 100,
      deliveryAddress: {
        city: evil,
        postalCode: evil,
        street: evil,
        apartmentOrOffice: evil,
      },
      orderUrl: "https://example.com/orders/x",
      supportEmail: "ok@example.com",
    });
    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&lt;script&gt;");
  });

  it("throws on an empty items array (schema invariant)", () => {
    expect(() =>
      renderOrderConfirmationEmail({
        to: "x@example.com",
        orderNumber: "2026-05-00099",
        placedAt: PLACED_AT,
        paymentMethod: "pay_at_store",
        items: [],
        subtotalCents: 0,
        discountPercent: 0,
        discountAmountCents: 0,
        totalCents: 0,
      }),
    ).toThrow(/items must be non-empty/);
  });

  it("formats EUR using bg-BG locale (digits and currency symbol present)", () => {
    const out = renderOrderConfirmationEmail({
      to: "x@example.com",
      orderNumber: "2026-05-00050",
      placedAt: PLACED_AT,
      paymentMethod: "pay_at_store",
      items: [
        {
          productCode: "SKU-X",
          productName: "X",
          quantity: 1,
          unitPriceCents: 1234,
        },
      ],
      subtotalCents: 1234,
      discountPercent: 0,
      discountAmountCents: 0,
      totalCents: 1234,
      currency: "EUR",
    });
    expect(out.text).toMatch(/12[,.]34/);
    expect(out.text).toContain("€");
  });
});
