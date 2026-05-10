import { describe, expect, it } from "vitest";
import {
  renderVerificationEmail,
  VERIFICATION_TEMPLATE_ID,
} from "../src/templates/verification.js";

describe("renderVerificationEmail", () => {
  it("produces a deterministic OutgoingEmail with matching subject/text/html", () => {
    const out = renderVerificationEmail({
      to: "ivan@example.com",
      verifyUrl: "https://shop.example.com/account/verify-email?token=abc.123",
      fullName: "Иван Петров",
      shopName: "Магазина",
    });
    expect(out.to).toBe("ivan@example.com");
    expect(out.subject).toBe("Потвърдете имейл адреса си");
    expect(out.templateId).toBe(VERIFICATION_TEMPLATE_ID);
    expect(out.text).toContain("Иван Петров");
    expect(out.text).toContain(
      "https://shop.example.com/account/verify-email?token=abc.123",
    );
    expect(out.text).toContain("24 часа");
    expect(out.html).toContain("Иван Петров");
    expect(out.html).toContain(
      "https://shop.example.com/account/verify-email?token=abc.123",
    );
  });

  it("falls back to a generic salutation when fullName is missing", () => {
    const out = renderVerificationEmail({
      to: "anon@example.com",
      verifyUrl: "https://shop.example.com/account/verify-email?token=x",
    });
    expect(out.text.startsWith("Здравейте!\n")).toBe(true);
    expect(out.html).toContain("Здравейте!");
  });

  it("HTML-escapes the verify URL inside attributes and visible text", () => {
    // A URL whose query string carries an apostrophe — implausible, but the
    // escaper has to handle it because the URL goes into both `href="…"` and
    // visible text. Otherwise we'd be one bug-fix away from an injection.
    const out = renderVerificationEmail({
      to: "x@example.com",
      verifyUrl: "https://shop.example.com/v?t=a'b\"<c>",
    });
    // The plain-text body keeps the URL verbatim — that is correct, plain
    // text has no escape rules.
    expect(out.text).toContain("https://shop.example.com/v?t=a'b\"<c>");
    // The HTML body must NOT contain the unescaped angle brackets verbatim
    // around the token (the `<c>` would become an empty element that the
    // user can never click). Look for the escaped form instead.
    expect(out.html).toContain("&lt;c&gt;");
    expect(out.html).toContain("&quot;");
    expect(out.html).toContain("&#39;");
  });
});
