import { describe, expect, it } from "vitest";
import {
  renderEmailChangeVerifyEmail,
  EMAIL_CHANGE_VERIFY_TEMPLATE_ID,
} from "../src/templates/email-change-verify.js";
import {
  renderEmailChangeAlertEmail,
  EMAIL_CHANGE_ALERT_TEMPLATE_ID,
} from "../src/templates/email-change-alert.js";
import {
  renderEmailChangedEmail,
  EMAIL_CHANGED_TEMPLATE_ID,
} from "../src/templates/email-changed.js";

describe("renderEmailChangeVerifyEmail", () => {
  it("produces a deterministic OutgoingEmail with matching subject/text/html", () => {
    const out = renderEmailChangeVerifyEmail({
      to: "new@example.com",
      verifyUrl:
        "https://shop.example.com/account/email-change/verify?token=abc.123",
      fullName: "Иван Петров",
      shopName: "Магазина",
    });
    expect(out.to).toBe("new@example.com");
    expect(out.subject).toBe("Потвърдете новия си имейл адрес");
    expect(out.templateId).toBe(EMAIL_CHANGE_VERIFY_TEMPLATE_ID);
    expect(out.text).toContain("Иван Петров");
    expect(out.text).toContain(
      "https://shop.example.com/account/email-change/verify?token=abc.123",
    );
    // OWASP cheatsheet: the recipient must learn the link is short-lived AND
    // that they should ignore if they didn't request the change.
    expect(out.text).toContain("1 час");
    expect(out.text).toContain("игнорирайте");
    expect(out.html).toContain("Иван Петров");
    expect(out.html).toContain(
      "https://shop.example.com/account/email-change/verify?token=abc.123",
    );
  });

  it("falls back to a generic salutation when fullName is missing", () => {
    const out = renderEmailChangeVerifyEmail({
      to: "anon@example.com",
      verifyUrl: "https://shop.example.com/account/email-change/verify?token=x",
    });
    expect(out.text.startsWith("Здравейте!\n")).toBe(true);
    expect(out.html).toContain("Здравейте!");
  });

  it("HTML-escapes the verify URL inside attributes and visible text", () => {
    const out = renderEmailChangeVerifyEmail({
      to: "x@example.com",
      verifyUrl: "https://shop.example.com/r?t=a'b\"<c>",
    });
    expect(out.text).toContain("https://shop.example.com/r?t=a'b\"<c>");
    expect(out.html).toContain("&lt;c&gt;");
    expect(out.html).toContain("&quot;");
    expect(out.html).toContain("&#39;");
  });

  it("warns the recipient that all sessions will be terminated", () => {
    // Same defensive-disclosure pattern as password-reset.
    const out = renderEmailChangeVerifyEmail({
      to: "x@example.com",
      verifyUrl: "https://shop.example.com/r?t=x",
    });
    expect(out.text).toContain("сесии");
  });
});

describe("renderEmailChangeAlertEmail", () => {
  it("addresses the recipient by name and prints the proposed new address", () => {
    const out = renderEmailChangeAlertEmail({
      to: "old@example.com",
      newEmail: "new@example.com",
      fullName: "Иван Петров",
      shopName: "Магазина",
      requestedAt: new Date("2026-05-10T10:00:00Z"),
      supportEmail: "support@example.com",
    });
    expect(out.subject).toBe("Заявка за смяна на имейл адреса");
    expect(out.templateId).toBe(EMAIL_CHANGE_ALERT_TEMPLATE_ID);
    expect(out.text).toContain("Иван Петров");
    expect(out.text).toContain("new@example.com");
    // The recipient (OLD address) must be told this is a HEADS-UP, not a
    // call to action — clicking nothing is the safe path.
    expect(out.text).toContain("НЕ сте поискали");
    expect(out.text).toContain("Не правете нищо");
    expect(out.text).toContain("support@example.com");
    expect(out.html).toContain("new@example.com");
    expect(out.html).toContain("support@example.com");
  });

  it("works without optional fields", () => {
    const out = renderEmailChangeAlertEmail({
      to: "x@example.com",
      newEmail: "y@example.com",
    });
    expect(out.text).toContain("Здравейте!");
    expect(out.html).toContain("Здравейте!");
    expect(out.text).toContain("y@example.com");
    expect(out.text).not.toContain("undefined");
    expect(out.html).not.toContain("undefined");
  });

  it("HTML-escapes the proposed new address (avoid HTML injection in the body)", () => {
    const out = renderEmailChangeAlertEmail({
      to: "x@example.com",
      newEmail: "<script>alert(1)</script>@example.com",
    });
    expect(out.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out.html).not.toContain("<script>alert(1)</script>");
  });
});

describe("renderEmailChangedEmail", () => {
  it("produces a deterministic notification email with the new address surfaced", () => {
    const out = renderEmailChangedEmail({
      to: "old@example.com",
      newEmail: "new@example.com",
      fullName: "Иван Петров",
      shopName: "Магазина",
      changedAt: new Date("2026-05-10T10:00:00Z"),
      supportEmail: "support@example.com",
    });
    expect(out.subject).toBe("Имейл адресът на акаунта Ви беше променен");
    expect(out.templateId).toBe(EMAIL_CHANGED_TEMPLATE_ID);
    expect(out.text).toContain("Иван Петров");
    expect(out.text).toContain("new@example.com");
    expect(out.text).toContain("сесии");
    expect(out.text).toContain("НЕ сте променяли");
    expect(out.text).toContain("support@example.com");
    expect(out.html).toContain("new@example.com");
    expect(out.html).toContain("support@example.com");
  });

  it("works without optional fields", () => {
    const out = renderEmailChangedEmail({
      to: "x@example.com",
      newEmail: "y@example.com",
    });
    expect(out.subject).toBe("Имейл адресът на акаунта Ви беше променен");
    expect(out.text).toContain("Здравейте!");
    expect(out.html).toContain("Здравейте!");
    expect(out.text).not.toContain("undefined");
    expect(out.html).not.toContain("undefined");
  });

  it("HTML-escapes the new address (defence against injection in stored emails)", () => {
    const out = renderEmailChangedEmail({
      to: "x@example.com",
      newEmail: "<b>not&html</b>@example.com",
    });
    expect(out.html).toContain("&lt;b&gt;not&amp;html&lt;/b&gt;@example.com");
    expect(out.html).not.toContain("<b>not&html</b>");
  });
});
