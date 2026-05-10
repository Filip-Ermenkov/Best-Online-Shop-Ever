import type { OutgoingEmail } from "../types.js";

/**
 * Email-verification template.
 *
 * Bulgarian copy (the customer-facing language). The button links to the
 * frontend URL the API was configured with — the frontend page POSTs the
 * token back to /auth/verify-email.
 *
 * The verification URL is the SOLE secret in the email. Never echo email
 * addresses or other PII into headers; never log the token. The template
 * is deterministic — same inputs always produce the same output, so future
 * snapshot tests stay stable.
 *
 * HTML rules:
 *   - Inline CSS only (Gmail, Outlook desktop, and most clients strip
 *     <style> blocks in <head>).
 *   - Tables for layout where alignment matters (Outlook still chokes on
 *     flexbox / grid in 2026).
 *   - System fonts only — webfont references download blocking.
 *   - Two action affordances: a styled button and a plain-text URL below it
 *     (clients that block buttons still let the user copy-paste).
 */

export interface VerificationTemplateInput {
  to: string;
  /** Pre-built absolute URL the user clicks. Includes the raw token. */
  verifyUrl: string;
  /** First name or full name from the customer profile. Optional. */
  fullName?: string | null;
  /** Brand name for the salutation. Defaults to "магазина". */
  shopName?: string;
}

export const VERIFICATION_TEMPLATE_ID = "auth.signup-verification";

export function renderVerificationEmail(
  input: VerificationTemplateInput,
): OutgoingEmail {
  const greeting = input.fullName ? `Здравейте, ${input.fullName}!` : "Здравейте!";
  const shopName = input.shopName ?? "магазина";
  const subject = "Потвърдете имейл адреса си";

  // Plain-text body — fallback for HTML-blocking clients AND a
  // deliverability signal (some spam scoring penalises HTML-only mail).
  const text = [
    greeting,
    "",
    `Благодарим Ви за регистрацията в ${shopName}!`,
    "За да активирате акаунта си и да правите поръчки, моля потвърдете имейл адреса си, като отворите следния линк:",
    "",
    input.verifyUrl,
    "",
    "Линкът е валиден 24 часа. Ако не сте се регистрирали, можете спокойно да игнорирате това съобщение — никой няма достъп до акаунта Ви, докато имейлът не бъде потвърден.",
    "",
    "Поздрави,",
    `Екипът на ${shopName}`,
  ].join("\n");

  // HTML body — single table, inline styles. The button is an <a> styled
  // as a button so non-button-supporting clients (e.g. Lotus Notes) still
  // get a link.
  const html = `<!doctype html>
<html lang="bg">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f5;">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:8px;border:1px solid #e4e4e7;">
            <tr>
              <td style="padding:32px 32px 16px 32px;">
                <h1 style="margin:0 0 16px 0;font-size:22px;font-weight:600;color:#18181b;">${escapeHtml(greeting)}</h1>
                <p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;color:#27272a;">
                  Благодарим Ви за регистрацията в ${escapeHtml(shopName)}!
                </p>
                <p style="margin:0 0 24px 0;font-size:15px;line-height:1.6;color:#27272a;">
                  За да активирате акаунта си и да правите поръчки, моля потвърдете имейл адреса си с бутона по-долу.
                </p>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:0 32px 24px 32px;">
                <a href="${escapeAttr(input.verifyUrl)}"
                   style="display:inline-block;padding:14px 28px;background-color:#0f172a;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;border-radius:6px;">
                  Потвърди имейла
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 24px 32px;">
                <p style="margin:0 0 8px 0;font-size:13px;line-height:1.6;color:#52525b;">
                  Ако бутонът не работи, копирайте този адрес в браузъра си:
                </p>
                <p style="margin:0 0 16px 0;font-size:13px;line-height:1.6;word-break:break-all;">
                  <a href="${escapeAttr(input.verifyUrl)}" style="color:#0f172a;text-decoration:underline;">${escapeHtml(input.verifyUrl)}</a>
                </p>
                <p style="margin:0;font-size:13px;line-height:1.6;color:#71717a;">
                  Линкът е валиден 24 часа. Ако не сте се регистрирали, можете спокойно да игнорирате това съобщение.
                </p>
              </td>
            </tr>
          </table>
          <p style="margin:16px 0 0 0;font-size:12px;color:#a1a1aa;">
            Това съобщение е автоматично — моля, не отговаряйте на него.
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return {
    to: input.to,
    subject,
    html,
    text,
    templateId: VERIFICATION_TEMPLATE_ID,
  };
}

/**
 * Tiny HTML escaper — no third-party dep. Covers the four characters that
 * matter for our usage (text content + `href` attribute values). Numeric
 * entity for `'` because the named `&apos;` entity is not in HTML4.
 */
function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Same as escapeHtml — kept as a separate function so a future tightening
 * (e.g. dropping non-ASCII for some clients) only edits one branch.
 */
function escapeAttr(s: string): string {
  return escapeHtml(s);
}
