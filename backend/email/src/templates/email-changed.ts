import type { OutgoingEmail } from "../types.js";

/**
 * "Your email address was changed" notification.
 *
 * Sent to the OLD email address AFTER a successful email-change confirmation,
 * so the original mailbox owner gets a final record of the change in their
 * inbox. Mirrors password-changed.ts in shape and rationale.
 *
 * Why only the OLD address?
 *   The NEW address just clicked a verification link — they trivially know
 *   the change happened. The party who might be surprised is the original
 *   mailbox owner; this email is their last chance to react if the change
 *   was unauthorised. (The OLD address ALSO received an alert at request
 *   time — this is the second touchpoint.)
 *
 * No actionable link in the body — the recipient's account has just been
 * detached from this mailbox. If the change was unauthorised, the recipient
 * still controls THIS email but not the account anymore; clicking a link to
 * "revert" wouldn't authenticate them. Instead the copy directs them to
 * contact support immediately.
 *
 * 2026 best-practice references:
 *   - OWASP "Changing A User's Registered Email Address For An Account"
 *   - NIST SP 800-63B-4 §5.2 (notification of subscriber-initiated changes)
 */

export interface EmailChangedTemplateInput {
  to: string;
  /** The new email address the account is now associated with. Surfaced for awareness. */
  newEmail: string;
  fullName?: string | null;
  shopName?: string;
  /** ISO-8601 timestamp the change took effect. Used in the audit-trail copy. */
  changedAt?: Date;
  /** Optional support contact, surfaced in the body. */
  supportEmail?: string;
}

export const EMAIL_CHANGED_TEMPLATE_ID = "auth.email-changed";

export function renderEmailChangedEmail(
  input: EmailChangedTemplateInput,
): OutgoingEmail {
  const greeting = input.fullName ? `Здравейте, ${input.fullName}!` : "Здравейте!";
  const shopName = input.shopName ?? "магазина";
  const subject = "Имейл адресът на акаунта Ви беше променен";
  const when = input.changedAt
    ? input.changedAt.toLocaleString("bg-BG", { timeZone: "Europe/Sofia" })
    : null;
  const support = input.supportEmail ?? null;

  const text = [
    greeting,
    "",
    `Информираме Ви, че имейл адресът на акаунта Ви в ${shopName} беше успешно променен${when ? ` на ${when} (часова зона София)` : ""}.`,
    "",
    `Новият адрес е: ${input.newEmail}`,
    "",
    "От съображения за сигурност всички активни сесии бяха прекратени. Бъдещи известия от акаунта няма да пристигат на този адрес.",
    "",
    "Ако ВИЕ извършихте промяната, можете спокойно да игнорирате това съобщение.",
    "",
    "Ако НЕ сте променяли имейл адреса си:",
    `  1. Свържете се с нас НЕЗАБАВНО${support ? ` на ${support}` : ""}. Акаунтът Ви може да е компрометиран — времето е критично.`,
    "  2. Сменете паролата на този имейл (тази поща), защото нападателят може да я знае.",
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
                  Информираме Ви, че имейл адресът на акаунта Ви в ${escapeHtml(shopName)} беше успешно променен${when ? ` на <strong>${escapeHtml(when)}</strong> (часова зона София)` : ""}.
                </p>
                <p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;color:#27272a;">
                  Новият адрес е:
                </p>
                <p style="margin:0 0 16px 0;padding:12px 16px;background-color:#f4f4f5;border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:14px;color:#18181b;word-break:break-all;">
                  ${escapeHtml(input.newEmail)}
                </p>
                <p style="margin:0 0 24px 0;font-size:15px;line-height:1.6;color:#27272a;">
                  От съображения за сигурност всички активни сесии бяха прекратени. Бъдещи известия от акаунта няма да пристигат на този адрес.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 24px 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#fef2f2;border:1px solid #fecaca;border-radius:6px;">
                  <tr>
                    <td style="padding:16px 20px;">
                      <p style="margin:0 0 8px 0;font-size:14px;font-weight:600;color:#991b1b;">
                        Ако НЕ сте променяли имейл адреса си:
                      </p>
                      <ol style="margin:0;padding-left:20px;font-size:13px;line-height:1.6;color:#7f1d1d;">
                        <li>Свържете се с нас НЕЗАБАВНО${support ? ` на <a href="mailto:${escapeAttr(support)}" style="color:#7f1d1d;text-decoration:underline;">${escapeHtml(support)}</a>` : ""}. Акаунтът Ви може да е компрометиран — времето е критично.</li>
                        <li>Сменете паролата на този имейл (тази поща), защото нападателят може да я знае.</li>
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
    templateId: EMAIL_CHANGED_TEMPLATE_ID,
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
