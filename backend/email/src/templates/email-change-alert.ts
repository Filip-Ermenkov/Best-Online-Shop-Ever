import type { OutgoingEmail } from "../types.js";

/**
 * Email-change ALERT — sent to the CURRENT (old) email address at REQUEST
 * time, before the change is confirmed.
 *
 * This is the OWASP "Changing A User's Registered Email Address" defence-in-
 * depth pattern: when a sensitive account change is requested, notify the
 * out-of-band channel (the currently-registered email) immediately, so the
 * legitimate owner has a chance to react before the change completes.
 *
 * The verify link in this email is NOT actionable from here — that goes to
 * the NEW address. This email contains the new address in plaintext for the
 * recipient's awareness, plus a runbook for the "this wasn't me" case
 * (change password, contact support). No link they can click to "revert"
 * — the change hasn't happened yet; doing nothing IS the revert.
 *
 * 2026 best-practice references:
 *   - OWASP "Changing A User's Registered Email Address For An Account"
 *   - NIST SP 800-63B-4 §5.2 (notification of subscriber-initiated changes)
 */

export interface EmailChangeAlertTemplateInput {
  to: string;
  /** The proposed new email address, shown in the body for the recipient's awareness. */
  newEmail: string;
  fullName?: string | null;
  shopName?: string;
  /** Timestamp the request was made. Used in the audit-trail copy. */
  requestedAt?: Date;
  /** Optional support contact, surfaced in the body. */
  supportEmail?: string;
}

export const EMAIL_CHANGE_ALERT_TEMPLATE_ID = "auth.email-change-alert";

export function renderEmailChangeAlertEmail(
  input: EmailChangeAlertTemplateInput,
): OutgoingEmail {
  const greeting = input.fullName ? `Здравейте, ${input.fullName}!` : "Здравейте!";
  const shopName = input.shopName ?? "магазина";
  const subject = "Заявка за смяна на имейл адреса";
  const when = input.requestedAt
    ? input.requestedAt.toLocaleString("bg-BG", { timeZone: "Europe/Sofia" })
    : null;
  const support = input.supportEmail ?? null;

  const text = [
    greeting,
    "",
    `Получихме заявка${when ? ` на ${when} (часова зона София)` : ""} за смяна на имейл адреса на акаунта Ви в ${shopName} към:`,
    "",
    `  ${input.newEmail}`,
    "",
    "Изпратихме линк за потвърждаване на новия адрес. Смяната ще влезе в сила едва след като той бъде потвърден от новия имейл.",
    "",
    "Ако ВИЕ сте поискали смяната, можете спокойно да игнорирате това съобщение и да продължите с потвърждаването от новия имейл.",
    "",
    "Ако НЕ сте поискали тази смяна:",
    "  1. Не правете нищо — смяната няма да влезе в сила без потвърждаване от новия адрес.",
    "  2. Влезте в акаунта си и сменете паролата си незабавно.",
    `  3. Свържете се с нас${support ? ` на ${support}` : ""} възможно най-скоро.`,
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
                  Получихме заявка${when ? ` на <strong>${escapeHtml(when)}</strong> (часова зона София)` : ""} за смяна на имейл адреса на акаунта Ви в ${escapeHtml(shopName)} към:
                </p>
                <p style="margin:0 0 16px 0;padding:12px 16px;background-color:#f4f4f5;border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:14px;color:#18181b;word-break:break-all;">
                  ${escapeHtml(input.newEmail)}
                </p>
                <p style="margin:0 0 24px 0;font-size:15px;line-height:1.6;color:#27272a;">
                  Изпратихме линк за потвърждаване на новия адрес. Смяната ще влезе в сила едва след като той бъде потвърден от новия имейл.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 24px 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#fef2f2;border:1px solid #fecaca;border-radius:6px;">
                  <tr>
                    <td style="padding:16px 20px;">
                      <p style="margin:0 0 8px 0;font-size:14px;font-weight:600;color:#991b1b;">
                        Ако НЕ сте поискали тази смяна:
                      </p>
                      <ol style="margin:0;padding-left:20px;font-size:13px;line-height:1.6;color:#7f1d1d;">
                        <li>Не правете нищо — смяната няма да влезе в сила без потвърждаване от новия адрес.</li>
                        <li>Влезте в акаунта си и сменете паролата си незабавно.</li>
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
                  Ако ВИЕ сте поискали смяната, можете спокойно да игнорирате това съобщение и да продължите с потвърждаването от новия имейл.
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
    templateId: EMAIL_CHANGE_ALERT_TEMPLATE_ID,
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
