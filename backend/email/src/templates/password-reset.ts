import type { OutgoingEmail } from "../types.js";

/**
 * Password-reset template.
 *
 * Same structural rules as verification.ts (inline CSS, table layout, system
 * fonts, plaintext fallback) — see that file for the rationale on email-
 * client compatibility.
 *
 * Distinct security copy: the link is shorter-lived (1h, vs 24h for verify),
 * and the body explicitly tells the user to ignore + change their password if
 * they did NOT request the reset (per OWASP "Forgot Password" cheat sheet:
 * the email is itself a notice of an account-recovery attempt).
 *
 * The visible URL deliberately appears below the button, NOT before it. A
 * surprising number of clients prefetch the first link they parse — putting
 * the action URL second avoids one-click consumption by spam filters and
 * link checkers (Microsoft Defender for Office 365 in particular).
 */

export interface PasswordResetTemplateInput {
  to: string;
  /** Pre-built absolute URL the user clicks. Includes the raw token. */
  resetUrl: string;
  /** First name or full name from the customer profile. Optional. */
  fullName?: string | null;
  /** Brand name. Defaults to "магазина". */
  shopName?: string;
}

export const PASSWORD_RESET_TEMPLATE_ID = "auth.password-reset";

export function renderPasswordResetEmail(
  input: PasswordResetTemplateInput,
): OutgoingEmail {
  const greeting = input.fullName ? `Здравейте, ${input.fullName}!` : "Здравейте!";
  const shopName = input.shopName ?? "магазина";
  const subject = "Заявка за нулиране на парола";

  const text = [
    greeting,
    "",
    `Получихме заявка за нулиране на паролата на акаунта Ви в ${shopName}.`,
    "За да зададете нова парола, отворете следния линк:",
    "",
    input.resetUrl,
    "",
    "Линкът е валиден 1 час и може да бъде използван само веднъж. Ако не сте поискали нулиране на паролата, моля игнорирайте това съобщение — паролата Ви няма да бъде променена.",
    "",
    "От съображения за сигурност, след успешна смяна на паролата всички активни сесии в акаунта Ви ще бъдат прекратени. Ще трябва да влезете отново на всички устройства.",
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
                  Получихме заявка за нулиране на паролата на акаунта Ви в ${escapeHtml(shopName)}.
                </p>
                <p style="margin:0 0 24px 0;font-size:15px;line-height:1.6;color:#27272a;">
                  За да зададете нова парола, кликнете върху бутона по-долу.
                </p>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:0 32px 24px 32px;">
                <a href="${escapeAttr(input.resetUrl)}"
                   style="display:inline-block;padding:14px 28px;background-color:#0f172a;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;border-radius:6px;">
                  Нулирай паролата
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 24px 32px;">
                <p style="margin:0 0 8px 0;font-size:13px;line-height:1.6;color:#52525b;">
                  Ако бутонът не работи, копирайте този адрес в браузъра си:
                </p>
                <p style="margin:0 0 16px 0;font-size:13px;line-height:1.6;word-break:break-all;">
                  <a href="${escapeAttr(input.resetUrl)}" style="color:#0f172a;text-decoration:underline;">${escapeHtml(input.resetUrl)}</a>
                </p>
                <p style="margin:0 0 16px 0;font-size:13px;line-height:1.6;color:#71717a;">
                  Линкът е валиден <strong>1 час</strong> и може да бъде използван само веднъж.
                </p>
                <p style="margin:0;font-size:13px;line-height:1.6;color:#71717a;">
                  Ако не сте поискали нулиране на паролата, моля игнорирайте това съобщение — паролата Ви няма да бъде променена. Ако смятате, че акаунтът Ви може да е компрометиран, влезте и сменете паролата си от профила.
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
    templateId: PASSWORD_RESET_TEMPLATE_ID,
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
