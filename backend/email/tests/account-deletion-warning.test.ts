import { describe, expect, it } from "vitest";
import {
  renderAccountDeletionWarningEmail,
  ACCOUNT_DELETION_WARNING_TEMPLATE_ID,
} from "../src/templates/account-deletion-warning.js";

describe("renderAccountDeletionWarningEmail", () => {
  // Registration + 7 days. 18 June 2026, 06:30 UTC → Sofia (EEST, UTC+3) 09:30.
  const DELETE_AFTER = new Date("2026-06-18T06:30:00Z");

  const baseInput = {
    to: "new-user@example.com",
    fullName: "Мария Георгиева",
    verifyUrl: "https://shop.example.com/account/verify-email?token=abc123",
    resendUrl: "https://shop.example.com",
    deleteAfter: DELETE_AFTER,
  };

  it("produces the day-6 warning with both spec CTAs", () => {
    const out = renderAccountDeletionWarningEmail(baseInput);

    expect(out.to).toBe("new-user@example.com");
    expect(out.templateId).toBe(ACCOUNT_DELETION_WARNING_TEMPLATE_ID);

    // The spec's exact framing: deleted TOMORROW because email not confirmed.
    expect(out.subject).toContain("изтрит утре");
    expect(out.text).toContain("ще бъде изтрит утре");
    expect(out.text).toContain("не е потвърден");

    // Personalised greeting.
    expect(out.text).toContain("Мария Георгиева");

    // CTA 1 — „Потвърди сега" with the fresh one-click verification link.
    expect(out.text).toContain(
      "https://shop.example.com/account/verify-email?token=abc123",
    );
    expect(out.html).toContain("Потвърди сега");
    expect(out.html).toContain(
      "https://shop.example.com/account/verify-email?token=abc123",
    );

    // CTA 2 — the "send a new link" path.
    expect(out.html).toContain("заявете нов линк");
    expect(out.text).toContain("https://shop.example.com");

    // The deadline, rendered in Sofia time (06:30 UTC → 09:30 EEST).
    expect(out.text).toMatch(/09:30/);
    expect(out.html).toMatch(/09:30/);

    // No action needed if the registration wasn't theirs — the data-friendly
    // outcome is the DEFAULT, stated explicitly (no guilt-trip dark pattern).
    expect(out.text).toContain("не е нужно да правите нищо");
  });

  it("falls back to a neutral greeting without a name", () => {
    const out = renderAccountDeletionWarningEmail({
      ...baseInput,
      fullName: null,
    });
    expect(out.text.startsWith("Здравейте,")).toBe(true);
    expect(out.text).not.toContain("Здравейте, ,");
  });

  it("escapes HTML in the display name", () => {
    const out = renderAccountDeletionWarningEmail({
      ...baseInput,
      fullName: `<b>x</b>`,
    });
    expect(out.html).not.toContain("<b>x</b>");
    expect(out.html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});
