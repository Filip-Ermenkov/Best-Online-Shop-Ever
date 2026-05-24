import type { OutgoingEmail } from "../types.js";

/**
 * "Your account was deleted" notification.
 *
 * Sent AFTER a successful GDPR Art. 17 right-to-erasure execution. The
 * recipient is the user's original (pre-pseudonymisation) email address;
 * the route layer captures it from the users row BEFORE the transaction
 * overwrites users.email with the deleted-<uuid>@deleted.invalid sentinel.
 *
 * The body is intentionally:
 *
 *   1. **Plain — no actionable link.** A "click here to undo" link would
 *      either be useless (the row is anonymised; there's nothing to
 *      restore to) or actively dangerous (an attacker who triggered the
 *      deletion via a stolen cookie could click the undo too). The post-
 *      action notification's job is to give the original owner a real-
 *      time alert; the right "undo" is to contact support, who can audit
 *      the request and tell the user definitively whether it was them.
 *
 *   2. **Explicit about retention.** Bulgarian Accountancy Act mandates a
 *      10-year retention period for invoices. Customers should know that
 *      "delete my account" does not erase past order records; only the
 *      PII linking those records to them as a person was anonymised.
 *      This is the GDPR Art. 13(2)(a) "data retention period" disclosure
 *      surfacing again at the moment it actually matters.
 *
 *   3. **Closes the loop on the security alert.** If an attacker
 *      triggered the deletion (which they could only do if they ALSO had
 *      the current password — re-auth gate — but defence-in-depth says
 *      to mail anyway), this email is the legitimate owner's first
 *      signal that something happened. The "what to do if it wasn't you"
 *      mirrors the post-password-change template.
 *
 * 2026 best-practice references:
 *   - OWASP Authentication CS, "Notify on account-sensitive changes"
 *   - GDPR Art. 12 (transparent communication of processing actions)
 *   - GDPR Art. 13(2)(a) (data retention period disclosure)
 */

export interface AccountDeletedTemplateInput {
  to: string;
  fullName?: string | null;
  shopName?: string;
  /** ISO-8601 timestamp the deletion was executed. Used in the audit-trail copy. */
  deletedAt?: Date;
  /** Optional support contact, surfaced in the body. */
  supportEmail?: string;
}

export const ACCOUNT_DELETED_TEMPLATE_ID = "auth.account-deleted";

export function renderAccountDeletedEmail(
  input: AccountDeletedTemplateInput,
): OutgoingEmail {
  const greeting = input.fullName ? `Здравейте, ${input.fullName}!` : "Здравейте!";
  const shopName = input.shopName ?? "магазина";
  const subject = "Акаунтът Ви беше изтрит";
  const when = input.deletedAt
    ? input.deletedAt.toLocaleString("bg-BG", { timeZone: "Europe/Sofia" })
    : null;
  const support = input.supportEmail ?? null;

  const text = [
    greeting,
    "",
    `Информираме Ви, че акаунтът Ви в ${shopName} беше изтрит${when ? ` на ${when} (часова зона София)` : ""}.`,
    "",
    "Какво беше изтрито:",
    "  • Профилните Ви данни (име, телефон, фирмени данни)",
    "  • Адресите от адресния Ви бележник",
    "  • Кошницата Ви",
    "  • Активните Ви сесии на всички устройства",
    "  • Имейл адресът Ви беше анонимизиран",
    "",
    "Какво се запазва (по закон):",
    "  • Историята на поръчките Ви — Законът за счетоводството на",
    "    Република България изисква 10-годишен срок на съхранение",
    "    за фактури и счетоводни документи. Свързаните лични данни",
    "    бяха псевдонимизирани там, където това е възможно без",
    "    нарушаване на изискванията за фискална отчетност.",
    "",
    `Можете да се регистрирате наново със същия имейл адрес${when ? ", ако пожелаете" : ""} — той вече е свободен.`,
    "",
    "Ако ВИЕ извършихте изтриването, можете спокойно да игнорирате това съобщение.",
    "",
    "Ако НЕ сте искали да изтриете акаунта си:",
    "  1. Влезте незабавно в имейл акаунта си и сменете и неговата парола.",
    `  2. Свържете се с нас${support ? ` на ${support}` : ""} възможно най-скоро.`,
    "",
    "Благодарим Ви, че бяхте с нас!",
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
                  Информираме Ви, че акаунтът Ви в ${escapeHtml(shopName)} беше изтрит${when ? ` на <strong>${escapeHtml(when)}</strong> (часова зона София)` : ""}.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 16px 32px;">
                <p style="margin:0 0 8px 0;font-size:14px;font-weight:600;color:#18181b;">Какво беше изтрито:</p>
                <ul style="margin:0 0 20px 0;padding-left:20px;font-size:14px;line-height:1.6;color:#27272a;">
                  <li>Профилните Ви данни (име, телефон, фирмени данни)</li>
                  <li>Адресите от адресния Ви бележник</li>
                  <li>Кошницата Ви</li>
                  <li>Активните Ви сесии на всички устройства</li>
                  <li>Имейл адресът Ви беше анонимизиран</li>
                </ul>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 24px 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#fefce8;border:1px solid #fde68a;border-radius:6px;">
                  <tr>
                    <td style="padding:16px 20px;">
                      <p style="margin:0 0 8px 0;font-size:14px;font-weight:600;color:#854d0e;">
                        Какво се запазва по закон:
                      </p>
                      <p style="margin:0;font-size:13px;line-height:1.6;color:#713f12;">
                        Историята на поръчките Ви — Законът за счетоводството
                        на Република България изисква 10-годишен срок на
                        съхранение за фактури и счетоводни документи.
                        Свързаните лични данни бяха псевдонимизирани там,
                        където това е възможно без нарушаване на изискванията
                        за фискална отчетност.
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 16px 32px;">
                <p style="margin:0;font-size:14px;line-height:1.6;color:#27272a;">
                  Можете да се регистрирате наново със същия имейл адрес${when ? ", ако пожелаете" : ""} — той вече е свободен.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 24px 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#fef2f2;border:1px solid #fecaca;border-radius:6px;">
                  <tr>
                    <td style="padding:16px 20px;">
                      <p style="margin:0 0 8px 0;font-size:14px;font-weight:600;color:#991b1b;">
                        Ако НЕ сте искали да изтриете акаунта си:
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
                  Ако ВИЕ извършихте изтриването, можете спокойно да игнорирате това съобщение.
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
    templateId: ACCOUNT_DELETED_TEMPLATE_ID,
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
