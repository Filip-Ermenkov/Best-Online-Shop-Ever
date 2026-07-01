import { describe, expect, it } from "vitest";
import {
  renderOrderStatusUpdateEmail,
  ORDER_STATUS_UPDATE_TEMPLATE_ID,
} from "../src/templates/order-status-update.js";

/**
 * Same pinned UTC timestamp as the other order-email tests. May DST → Sofia
 * is UTC+3, so 14:23:07 UTC renders as 17:23:07 local.
 */
const CHANGED_AT = new Date("2026-05-12T14:23:07Z");

describe("renderOrderStatusUpdateEmail", () => {
  it("renders an `accepted` transition with withdrawal-rights pointer", () => {
    const out = renderOrderStatusUpdateEmail({
      to: "customer@example.com",
      fullName: "Иван Петров",
      orderNumber: "2026-05-00042",
      status: "accepted",
      changedAt: CHANGED_AT,
      shopName: "Магазина",
      supportEmail: "support@example.com",
      orderUrl: "https://example.com/account/orders/2026-05-00042",
    });

    expect(out.to).toBe("customer@example.com");
    expect(out.subject).toBe("Поръчка 2026-05-00042 — приета");
    expect(out.templateId).toBe(ORDER_STATUS_UPDATE_TEMPLATE_ID);

    expect(out.text).toContain("Иван Петров");
    expect(out.text).toContain("Приета");
    expect(out.text).toContain("чл. 50"); // Bulgarian Consumer Protection Act
    expect(out.text).toContain("2023/2673"); // EU directive cited
    expect(out.text).toContain("14");

    expect(out.text).toMatch(/17:23/); // Sofia tz
    expect(out.text).toContain("Европа/София");

    expect(out.text).toContain("support@example.com");
    expect(out.html).toContain(
      "https://example.com/account/orders/2026-05-00042",
    );
  });

  it("renders `ready_for_pickup` with the pickup deadline when supplied", () => {
    const deadline = new Date("2026-05-19T18:00:00Z");
    const out = renderOrderStatusUpdateEmail({
      to: "customer@example.com",
      orderNumber: "2026-05-00043",
      status: "ready_for_pickup",
      changedAt: CHANGED_AT,
      pickupDeadline: deadline,
    });

    expect(out.subject).toBe("Поръчка 2026-05-00043 — готова за получаване");
    expect(out.text).toContain("Готова за получаване");
    expect(out.text).toContain("Срок за получаване");
    // The deadline-formatter is date-only — assert the day appears.
    expect(out.text).toMatch(/19/);
  });

  it("renders the store contact block for ready_for_pickup when shopContact is supplied", () => {
    const out = renderOrderStatusUpdateEmail({
      to: "customer@example.com",
      orderNumber: "2026-05-00043",
      status: "ready_for_pickup",
      changedAt: CHANGED_AT,
      shopContact: {
        email: "info@duda1.bg",
        phone: "+359 2 900 1234",
        address: "ул. Витоша 15, София 1000",
        hours: "Пон-Пет: 9:00-18:00",
      },
    });

    expect(out.text).toContain("Контакти на магазина");
    expect(out.text).toContain("ул. Витоша 15, София 1000");
    expect(out.text).toContain("Пон-Пет: 9:00-18:00");
    expect(out.text).toContain("+359 2 900 1234");
    expect(out.text).toContain("info@duda1.bg");
    expect(out.html).toContain("Контакти на магазина");
    expect(out.html).toContain("ул. Витоша 15, София 1000");
    // tel: href is whitespace-stripped; mailto: as-is.
    expect(out.html).toContain('href="tel:+35929001234"');
    expect(out.html).toContain('href="mailto:info@duda1.bg"');
  });

  it("omits the store contact block for non-pickup statuses even if shopContact is passed", () => {
    const out = renderOrderStatusUpdateEmail({
      to: "customer@example.com",
      orderNumber: "2026-05-00044",
      status: "shipped",
      changedAt: CHANGED_AT,
      shopContact: {
        email: "info@duda1.bg",
        phone: "+359 2 900 1234",
        address: "ул. Витоша 15",
        hours: "9-18",
      },
    });

    expect(out.text).not.toContain("Контакти на магазина");
    expect(out.html).not.toContain("Контакти на магазина");
  });

  it("renders `shipped` with courier + tracking when supplied", () => {
    const out = renderOrderStatusUpdateEmail({
      to: "customer@example.com",
      orderNumber: "2026-05-00044",
      status: "shipped",
      changedAt: CHANGED_AT,
      courierCompany: "Speedy",
      trackingNumber: "SP-1234567890",
    });

    expect(out.subject).toBe("Поръчка 2026-05-00044 — изпратена");
    expect(out.text).toContain("Изпратена");
    expect(out.text).toContain("Speedy");
    expect(out.text).toContain("SP-1234567890");
    expect(out.html).toContain("Speedy");
    expect(out.html).toContain("SP-1234567890");
  });

  it("renders `shipped` without courier fields when they are not provided", () => {
    const out = renderOrderStatusUpdateEmail({
      to: "customer@example.com",
      orderNumber: "2026-05-00045",
      status: "shipped",
      changedAt: CHANGED_AT,
    });

    expect(out.text).toContain("Изпратена");
    expect(out.text).not.toContain("Куриер:");
    expect(out.text).not.toContain("Номер за проследяване");
  });

  it("renders `delivered` as a neutral close-out", () => {
    const out = renderOrderStatusUpdateEmail({
      to: "customer@example.com",
      orderNumber: "2026-05-00046",
      status: "delivered",
      changedAt: CHANGED_AT,
    });

    expect(out.subject).toBe("Поръчка 2026-05-00046 — доставена");
    expect(out.text).toContain("Доставена");
    expect(out.text).toContain("доставена");
  });

  it("renders `cancelled` with the cancellation reason verbatim", () => {
    const out = renderOrderStatusUpdateEmail({
      to: "customer@example.com",
      orderNumber: "2026-05-00047",
      status: "cancelled",
      changedAt: CHANGED_AT,
      cancelledReason: "Стоката е изчерпана.",
    });

    expect(out.subject).toBe("Поръчка 2026-05-00047 — анулирана");
    expect(out.text).toContain("Анулирана");
    expect(out.text).toContain("Стоката е изчерпана.");
    expect(out.html).toContain("Стоката е изчерпана.");
  });

  it("falls back to a generic salutation when fullName is missing", () => {
    const out = renderOrderStatusUpdateEmail({
      to: "anon@example.com",
      orderNumber: "2026-05-00048",
      status: "accepted",
      changedAt: CHANGED_AT,
    });
    expect(out.text.startsWith("Здравейте!\n")).toBe(true);
  });

  it("HTML-escapes injection-prone fields", () => {
    const evil = `</td><script>alert(1)</script>`;
    const out = renderOrderStatusUpdateEmail({
      to: "x@example.com",
      fullName: evil,
      orderNumber: evil,
      status: "cancelled",
      changedAt: CHANGED_AT,
      cancelledReason: evil,
      courierCompany: evil,
      trackingNumber: evil,
    });
    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&lt;script&gt;");
  });
});
