import type { OutgoingEmail } from "../types.js";

/**
 * Email-change verification template.
 *
 * Sent to the NEW email address when a user requests an email change. The
 * recipient (presumed owner of the new address) clicks the link to confirm
 * they really do control that mailbox. Until they click, the user's
 * `users.email` is untouched — the proposed-new value lives only on the
 * `email_verification_tokens.new_email` column.
 *
 * Structurally identical to password-reset.ts on purpose (inline CSS, table
 * layout, system fonts, plaintext fallback, action URL AFTER the button to
 * dodge link-prefetching scanners). The distinct copy:
 *
 *   - Subject is "Потвърдете новия си имейл адрес" so the recipient sees at
 *     a glance why they got this — they may have JUST changed it on a
 *     different device.
 *   - 1h validity, matching password-reset. OWASP recommends ≤1h for
 *     security-sensitive recovery flows. Email change qualifies.
 *   - Body explicitly tells the recipient to ignore + alert the original
 *     address's owner if they did NOT request this. Defence in depth: the
 *     OLD address ALSO got an alert at request time, but redundancy here
 *     is cheap.
 */

export interface EmailChangeVerifyTemplateInput {
  to: string;
  /** Pre-built absolute URL the user clicks. Includes the raw token. */
  verifyUrl: string;
  /** First name or full name from the customer profile. Optional. */
  fullName?: string | null;
  /** Brand name. Defaults to "магазина". */
  shopName?: string;
}

export const EMAIL_CHANGE_VERIFY_TEMPLATE_ID = "auth.email-change-verify";

export function renderEmailChangeVerifyEmail(
  input: EmailChangeVerifyTemplateInput,
): OutgoingEmail {
  const greeting = input.fullName ? `Здравейте, ${input.fullName}!` : "Здравейте!";
  const shopName = input.shopName ?? "магазина";
  const subject = "Потвърдете новия си имейл адрес";

  const text = [
    greeting,
    "",
    `Получихме заявка за смяна на имейл адреса на акаунта Ви в ${shopName} към този адрес.`,
    "За да потвърдите смяната, отворете следния линк:",
    "",
    input.verifyUrl,
    "",
    "Линкът е валиден 1 час и може да бъде използван само веднъж. След потвърждаването всички активни сесии в акаунта Ви ще бъдат прекратени и ще трябва да влезете отново с новия имейл адрес.",
    "",
    "Ако НЕ сте поискали тази смяна, моля игнорирайте това съобщение — нищо няма да се промени. Препоръчваме Ви също да проверите акаунта си и да смените паролата.",
    "",
    "Поздрави,",
    `Екипът на ${shopName}`,
  ].join("\n");

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
                  Получихме заявка за смяна на имейл адреса на акаунта Ви в ${escapeHtml(shopName)} към този адрес.
                </p>
                <p style="margin:0 0 24px 0;font-size:15px;line-height:1.6;color:#27272a;">
                  За да потвърдите смяната, кликнете върху бутона по-долу.
                </p>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:0 32px 24px 32px;">
                <a href="${escapeAttr(input.verifyUrl)}"
                   style="display:inline-block;padding:14px 28px;background-color:#0f172a;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;border-radius:6px;">
                  Потвърди новия имейл
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
                <p style="margin:0 0 16px 0;font-size:13px;line-height:1.6;color:#71717a;">
                  Линкът е валиден <strong>1 час</strong> и може да бъде използван само веднъж. След потвърждаването всички активни сесии в акаунта Ви ще бъдат прекратени.
                </p>
                <p style="margin:0;font-size:13px;line-height:1.6;color:#71717a;">
                  Ако не сте поискали тази смяна, моля игнорирайте това съобщение — нищо няма да се промени. Препоръчваме Ви също да влезете в акаунта си и да смените паролата.
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
    templateId: EMAIL_CHANGE_VERIFY_TEMPLATE_ID,
  };
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
