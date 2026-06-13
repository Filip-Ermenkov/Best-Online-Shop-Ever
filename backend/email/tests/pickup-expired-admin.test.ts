import { describe, expect, it } from "vitest";
import {
  renderPickupExpiredAdminEmail,
  PICKUP_EXPIRED_ADMIN_TEMPLATE_ID,
} from "../src/templates/pickup-expired-admin.js";

describe("renderPickupExpiredAdminEmail", () => {
  // Pin time so the formatted-timestamp assertion is deterministic. 10 June
  // 2026, 15:00:00 UTC → Europe/Sofia is UTC+3 in June (EEST) → 18:00 local.
  const DEADLINE = new Date("2026-06-10T15:00:00Z");

  const baseInput = {
    to: "support@example.com",
    orderNumber: "2026-06-00031",
    pickupDeadline: DEADLINE,
    customerName: "Иван Петров",
    customerEmail: "ivan@example.com",
    customerPhone: "+359888123456",
    adminOrderUrl: "https://shop.example.com/admin/orders/2026-06-00031",
  };

  it("produces the operations-focused admin notification", () => {
    const out = renderPickupExpiredAdminEmail(baseInput);

    expect(out.to).toBe("support@example.com");
    expect(out.subject).toBe("Изтекъл срок за вземане: поръчка 2026-06-00031");
    expect(out.templateId).toBe(PICKUP_EXPIRED_ADMIN_TEMPLATE_ID);

    // Order number first-class in both bodies (spec §7: номер на поръчката).
    expect(out.text).toContain("2026-06-00031");
    expect(out.html).toContain("2026-06-00031");

    // Customer contact block (spec §7: данните на клиента).
    expect(out.text).toContain("Иван Петров");
    expect(out.text).toContain("ivan@example.com");
    expect(out.text).toContain("+359888123456");
    expect(out.html).toContain("Иван Петров");
    expect(out.html).toContain("mailto:ivan@example.com");
    expect(out.html).toContain("tel:+359888123456");

    // The expired deadline, rendered in Sofia time (15:00 UTC → 18:00 EEST).
    expect(out.text).toMatch(/18:00/);
    expect(out.html).toMatch(/18:00/);
    expect(out.text).toContain("Европа/София");

    // The decision stays MANUAL (spec §7: „Администраторът трябва ръчно да
    // реши…") — both options are spelled out, no auto-cancel language.
    expect(out.text).toContain("нова уговорка");
    expect(out.text).toContain("Откажете поръчката");
    expect(out.text.toLowerCase()).not.toContain("отказана автоматично");

    // Deep link to the admin panel.
    expect(out.text).toContain("https://shop.example.com/admin/orders/2026-06-00031");
    expect(out.html).toContain("https://shop.example.com/admin/orders/2026-06-00031");
  });

  it("escapes HTML in customer-controlled fields", () => {
    const out = renderPickupExpiredAdminEmail({
      ...baseInput,
      customerName: `<script>alert("x")</script>`,
    });
    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&lt;script&gt;");
    // text/plain part carries it verbatim — fine, no HTML context there.
    expect(out.text).toContain(`<script>alert("x")</script>`);
  });
});
