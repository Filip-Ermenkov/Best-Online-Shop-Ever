import type { OutgoingEmail } from "../types.js";

/**
 * "Your password was changed" notification.
 *
 * Sent AFTER a successful password reset. This is a defence in depth — if an
 * attacker has reset a victim's password (e.g. via a compromised email
 * inbox), this email gives the victim a real-time alert that something just
 * happened on their account, plus a clear next step.
 *
 * No actionable link in the body — the recipient already lost control of
 * their email if a reset was triggered without their knowledge, so any
 * "click here to undo" link in the email itself would just be another vector
 * for the same attacker. Instead the copy directs the user to contact
 * support and to lock down their email account.
 *
 * 2026 best-practice references:
 *   - OWASP Authentication CS, "Notify on password changes"
 *   - NIST SP 800-63B-4 §5.1.1.2 (out-of-band reauthentication notice)
 */

export interface PasswordChangedTemplateInput {
  to: string;
  fullName?: string | null;
  shopName?: string;
  /** ISO-8601 timestamp the change occurred. Used in the audit-trail copy. */
  changedAt?: Date;
  /** Optional support contact, surfaced in the body. */
  supportEmail?: string;
}

export const PASSWORD_CHANGED_TEMPLATE_ID = "auth.password-changed";

export function renderPasswordChangedEmail(
  input: PasswordChangedTemplateInput,
): OutgoingEmail {
  const greeting = input.fullName ? `Здравейте, ${input.fullName}!` : "Здравейте!";
  const shopName = input.shopName ?? "магазина";
  const subject = "Паролата Ви беше променена";
  const when = input.changedAt
    ? input.changedAt.toLocaleString("bg-BG", { timeZone: "Europe/Sofia" })
    : null;
  const support = input.supportEmail ?? null;

  const text = [
    greeting,
    "",
    `Информираме Ви, че паролата на акаунта Ви в ${shopName} беше успешно променена${when ? ` на ${when} (часова зона София)` : ""}.`,
    "",
    "От съображения за сигурност всички активни сесии бяха прекратени. Ще трябва да влезете отново на всички устройства с новата парола.",
    "",
    "Ако ВИЕ извършихте промяната, можете спокойно да игнорирате това съобщение.",
    "",
    "Ако НЕ сте променяли паролата си:",
    "  1. Влезте незабавно в имейл акаунта си и сменете и неговата парола.",
    `  2. Свържете се с нас${support ? ` на ${support}` : ""} възможно най-скоро.`,
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
                  Информираме Ви, че паролата на акаунта Ви в ${escapeHtml(shopName)} беше успешно променена${when ? ` на <strong>${escapeHtml(when)}</strong> (часова зона София)` : ""}.
                </p>
                <p style="margin:0 0 24px 0;font-size:15px;line-height:1.6;color:#27272a;">
                  От съображения за сигурност всички активни сесии бяха прекратени. Ще трябва да влезете отново на всички устройства с новата парола.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 24px 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#fef2f2;border:1px solid #fecaca;border-radius:6px;">
                  <tr>
                    <td style="padding:16px 20px;">
                      <p style="margin:0 0 8px 0;font-size:14px;font-weight:600;color:#991b1b;">
                        Ако НЕ сте променяли паролата си:
                      </p>
                      <ol style="margin:0;padding-left:20px;font-size:13px;line-height:1.6;color:#7f1d1d;">
                        <li>Влезте незабавно в имейл акаунта си и сменете и неговата парола.</li>
                        <li>Свържете се с нас${support ? ` на <a href="mailto:${escapeAttr(support)}" style="color:#7f1d1d;text-decoration:underline;">${escapeHtml(support)}</a>` : ""} възможно най-скоро.</li>
                      </ol>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 24px 32px;">
                <p style="margin:0;font-size:13px;line-height:1.6;color:#71717a;">
                  Ако ВИЕ извършихте промяната, можете спокойно да игнорирате това съобщение.
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
    templateId: PASSWORD_CHANGED_TEMPLATE_ID,
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
