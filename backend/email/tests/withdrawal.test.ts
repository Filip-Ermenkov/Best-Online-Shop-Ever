import { describe, expect, it } from "vitest";
import {
  renderWithdrawalReceivedEmail,
  WITHDRAWAL_RECEIVED_TEMPLATE_ID,
} from "../src/templates/withdrawal-received.js";
import {
  renderWithdrawalAdminNotificationEmail,
  WITHDRAWAL_ADMIN_NOTIFICATION_TEMPLATE_ID,
} from "../src/templates/withdrawal-admin-notification.js";

describe("renderWithdrawalReceivedEmail", () => {
  // Pin time so the formatted-timestamp assertion is deterministic across
  // CI / local. 12 May 2026, 14:23:07 UTC → Europe/Sofia is UTC+3 in May
  // (EEST, daylight savings) → 17:23:07 local.
  const SUBMITTED_AT = new Date("2026-05-12T14:23:07Z");

  it("produces an OutgoingEmail with order, timestamp and durable-medium copy", () => {
    const out = renderWithdrawalReceivedEmail({
      to: "customer@example.com",
      fullName: "Иван Петров",
      orderNumber: "2026-05-00042",
      submittedAt: SUBMITTED_AT,
      supportEmail: "support@example.com",
      shopName: "Магазина",
    });

    expect(out.to).toBe("customer@example.com");
    expect(out.subject).toBe("Получихме отказа Ви от поръчка 2026-05-00042");
    expect(out.templateId).toBe(WITHDRAWAL_RECEIVED_TEMPLATE_ID);

    // Greeting personalised.
    expect(out.text).toContain("Иван Петров");
    expect(out.html).toContain("Иван Петров");

    // Identifies the contract (Art. 11a(1)(c)).
    expect(out.text).toContain("2026-05-00042");
    expect(out.html).toContain("2026-05-00042");

    // Names the legal basis.
    expect(out.text).toContain("чл. 50");
    expect(out.text).toContain("Закон");

    // Renders the timestamp explicitly with Sofia timezone (Art. 11a(2)
    // — "date and time" requirement). 17:23 is the May-DST conversion of
    // 14:23 UTC; we don't assert the exact ICU separator (it varies across
    // Node versions) but the hour/minute components must be present.
    expect(out.text).toMatch(/17:23/);
    expect(out.html).toMatch(/17:23/);
    expect(out.text).toContain("Европа/София");
    expect(out.html).toContain("Европа/София");

    // Support contact surfaced.
    expect(out.text).toContain("support@example.com");
    expect(out.html).toContain("support@example.com");

    // No dark patterns — recital 37: no nag, no upsell, no countdown.
    // Sanity assertion: the body does NOT contain anti-patterns.
    expect(out.text.toLowerCase()).not.toContain("сигурни ли сте");
    expect(out.text.toLowerCase()).not.toContain("отмени отказа");
  });

  it("falls back to a generic salutation when fullName is missing", () => {
    const out = renderWithdrawalReceivedEmail({
      to: "anon@example.com",
      orderNumber: "2026-05-00007",
      submittedAt: SUBMITTED_AT,
    });
    expect(out.text.startsWith("Здравейте!\n")).toBe(true);
    expect(out.html).toContain("Здравейте!");
  });

  it("includes the user's reason verbatim when supplied", () => {
    const out = renderWithdrawalReceivedEmail({
      to: "customer@example.com",
      orderNumber: "2026-05-00099",
      submittedAt: SUBMITTED_AT,
      description: "Размерът не ми пасва.",
    });
    expect(out.text).toContain("Размерът не ми пасва.");
    expect(out.html).toContain("Размерът не ми пасва.");
  });

  it("HTML-escapes injection-prone fields", () => {
    const evil = `</td><script>alert(1)</script>`;
    const out = renderWithdrawalReceivedEmail({
      to: "x@example.com",
      fullName: evil,
      orderNumber: evil,
      submittedAt: SUBMITTED_AT,
      description: evil,
      supportEmail: "ok@example.com",
    });
    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&lt;script&gt;");
  });
});

describe("renderWithdrawalAdminNotificationEmail", () => {
  const SUBMITTED_AT = new Date("2026-05-12T14:23:07Z");

  it("produces an OutgoingEmail with customer contact + reason", () => {
    const out = renderWithdrawalAdminNotificationEmail({
      to: "support@example.com",
      orderNumber: "2026-05-00042",
      submittedAt: SUBMITTED_AT,
      customerEmail: "customer@example.com",
      customerName: "Иван Петров",
      customerPhone: "+359888123456",
      description: "Размерът не ми пасва.",
    });

    expect(out.to).toBe("support@example.com");
    expect(out.subject).toBe("Отказ от договор: поръчка 2026-05-00042");
    expect(out.templateId).toBe(WITHDRAWAL_ADMIN_NOTIFICATION_TEMPLATE_ID);

    // All operational fields surface.
    expect(out.text).toContain("2026-05-00042");
    expect(out.text).toContain("Иван Петров");
    expect(out.text).toContain("customer@example.com");
    expect(out.text).toContain("+359888123456");
    expect(out.text).toContain("Размерът не ми пасва.");
    expect(out.html).toContain("Иван Петров");
    expect(out.html).toContain("customer@example.com");
    expect(out.html).toContain("+359888123456");

    // Timestamp in Sofia.
    expect(out.text).toMatch(/17:23/);
    expect(out.text).toContain("Европа/София");
  });

  it("omits the reason block when description is empty/whitespace", () => {
    const out = renderWithdrawalAdminNotificationEmail({
      to: "support@example.com",
      orderNumber: "2026-05-00042",
      submittedAt: SUBMITTED_AT,
      customerEmail: "c@example.com",
      customerName: "X",
      customerPhone: "+1",
      description: "   ",
    });
    expect(out.text).not.toContain("Посочена причина");
    expect(out.html).not.toContain("Посочена причина");
  });

  it("HTML-escapes injection-prone fields", () => {
    const evil = `</td><script>alert(1)</script>`;
    const out = renderWithdrawalAdminNotificationEmail({
      to: "support@example.com",
      orderNumber: evil,
      submittedAt: SUBMITTED_AT,
      customerEmail: evil,
      customerName: evil,
      customerPhone: evil,
      description: evil,
    });
    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&lt;script&gt;");
  });
});
