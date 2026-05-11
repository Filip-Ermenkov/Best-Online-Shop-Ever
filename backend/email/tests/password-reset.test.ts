import { describe, expect, it } from "vitest";
import {
  renderPasswordResetEmail,
  PASSWORD_RESET_TEMPLATE_ID,
} from "../src/templates/password-reset.js";
import {
  renderPasswordChangedEmail,
  PASSWORD_CHANGED_TEMPLATE_ID,
} from "../src/templates/password-changed.js";

describe("renderPasswordResetEmail", () => {
  it("produces a deterministic OutgoingEmail with matching subject/text/html", () => {
    const out = renderPasswordResetEmail({
      to: "ivan@example.com",
      resetUrl: "https://shop.example.com/account/reset-password?token=abc.123",
      fullName: "Иван Петров",
      shopName: "Магазина",
    });
    expect(out.to).toBe("ivan@example.com");
    expect(out.subject).toBe("Заявка за нулиране на парола");
    expect(out.templateId).toBe(PASSWORD_RESET_TEMPLATE_ID);
    expect(out.text).toContain("Иван Петров");
    expect(out.text).toContain(
      "https://shop.example.com/account/reset-password?token=abc.123",
    );
    expect(out.text).toContain("1 час");
    // OWASP cheatsheet: the email itself must surface the "ignore if you
    // didn't request this" branch — it doubles as a security notice.
    expect(out.text).toContain("игнорирайте");
    expect(out.html).toContain("Иван Петров");
    expect(out.html).toContain(
      "https://shop.example.com/account/reset-password?token=abc.123",
    );
  });

  it("falls back to a generic salutation when fullName is missing", () => {
    const out = renderPasswordResetEmail({
      to: "anon@example.com",
      resetUrl: "https://shop.example.com/account/reset-password?token=x",
    });
    expect(out.text.startsWith("Здравейте!\n")).toBe(true);
    expect(out.html).toContain("Здравейте!");
  });

  it("HTML-escapes the reset URL inside attributes and visible text", () => {
    const out = renderPasswordResetEmail({
      to: "x@example.com",
      resetUrl: "https://shop.example.com/r?t=a'b\"<c>",
    });
    expect(out.text).toContain("https://shop.example.com/r?t=a'b\"<c>");
    expect(out.html).toContain("&lt;c&gt;");
    expect(out.html).toContain("&quot;");
    expect(out.html).toContain("&#39;");
  });

  it("warns the recipient that all sessions will be terminated", () => {
    // The user must learn this BEFORE clicking through, so we don't surprise
    // people who have multiple devices logged in.
    const out = renderPasswordResetEmail({
      to: "x@example.com",
      resetUrl: "https://shop.example.com/r?t=x",
    });
    expect(out.text).toContain("сесии");
  });
});

describe("renderPasswordChangedEmail", () => {
  it("produces a deterministic notification email", () => {
    const out = renderPasswordChangedEmail({
      to: "ivan@example.com",
      fullName: "Иван Петров",
      shopName: "Магазина",
      changedAt: new Date("2026-05-10T10:00:00Z"),
      supportEmail: "support@example.com",
    });
    expect(out.subject).toBe("Паролата Ви беше променена");
    expect(out.templateId).toBe(PASSWORD_CHANGED_TEMPLATE_ID);
    expect(out.text).toContain("Иван Петров");
    expect(out.text).toContain("сесии");
    // Defence-in-depth: tell the user what to do if it WASN'T them.
    expect(out.text).toContain("НЕ сте променяли");
    expect(out.text).toContain("support@example.com");
    expect(out.html).toContain("support@example.com");
  });

  it("works without optional fields", () => {
    const out = renderPasswordChangedEmail({ to: "x@example.com" });
    expect(out.subject).toBe("Паролата Ви беше променена");
    expect(out.text).toContain("Здравейте!");
    expect(out.html).toContain("Здравейте!");
    // No support address — the body still has the actionable copy, just
    // without a contact target.
    expect(out.text).not.toContain("undefined");
    expect(out.html).not.toContain("undefined");
  });

  it("HTML-escapes the support email", () => {
    const out = renderPasswordChangedEmail({
      to: "x@example.com",
      supportEmail: "a&b@example.com",
    });
    expect(out.html).toContain("a&amp;b@example.com");
  });
});
