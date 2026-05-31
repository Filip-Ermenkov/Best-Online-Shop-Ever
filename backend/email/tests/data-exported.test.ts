import { describe, expect, it } from "vitest";
import {
  renderDataExportedEmail,
  DATA_EXPORTED_TEMPLATE_ID,
} from "../src/templates/data-exported.js";

describe("renderDataExportedEmail", () => {
  it("produces a deterministic OutgoingEmail with matching subject/text/html", () => {
    const out = renderDataExportedEmail({
      to: "ivan@example.com",
      fullName: "Иван Петров",
      shopName: "Магазина",
      exportedAt: new Date("2026-05-29T10:30:00.000Z"),
      supportEmail: "support@example.com",
    });
    expect(out.to).toBe("ivan@example.com");
    expect(out.subject).toBe("Данните на акаунта Ви бяха експортирани");
    expect(out.templateId).toBe(DATA_EXPORTED_TEMPLATE_ID);
    expect(out.text).toContain("Иван Петров");
    // GDPR articles cited in the body so the notice doubles as an Art. 12
    // intelligible-communication record.
    expect(out.text).toContain("чл. 15");
    expect(out.text).toContain("чл. 20");
    // Security guidance for the "wasn't me" path.
    expect(out.text).toContain("сменете паролата");
    expect(out.text).toContain("support@example.com");
    expect(out.html).toContain("Иван Петров");
    expect(out.html).toContain("support@example.com");
  });

  it("renders the Sofia-timezone instant in the body", () => {
    const out = renderDataExportedEmail({
      to: "ivan@example.com",
      exportedAt: new Date("2026-05-29T10:30:00.000Z"),
    });
    // 10:30 UTC is 13:30 in Europe/Sofia (UTC+3 in summer). Assert the
    // localised hour shows up rather than the raw UTC string.
    expect(out.text).toContain("13:30");
    expect(out.text).toContain("София");
  });

  it("falls back to a generic salutation when fullName is missing", () => {
    const out = renderDataExportedEmail({ to: "anon@example.com" });
    expect(out.text.startsWith("Здравейте!\n")).toBe(true);
    expect(out.html).toContain("Здравейте!");
  });

  it("does NOT attach or link the exported data (security posture)", () => {
    const out = renderDataExportedEmail({ to: "x@example.com" });
    // The notice must not carry the payload, and must explicitly say so.
    expect(out.text).toContain("НЕ е прикачен");
    expect(out.html.toLowerCase()).toContain("не е прикачен");
    // No external download link of any kind in the notice (mailto is fine,
    // but there is none here because no supportEmail was provided).
    expect(out.html).not.toContain('href="http');
  });

  it("omits the support sentence cleanly when no supportEmail is given", () => {
    const out = renderDataExportedEmail({ to: "x@example.com" });
    expect(out.text).toContain("Свържете се с нас възможно най-скоро.");
    // No dangling "на " with nothing after it.
    expect(out.text).not.toContain("Свържете се с нас на  възможно");
  });
});
