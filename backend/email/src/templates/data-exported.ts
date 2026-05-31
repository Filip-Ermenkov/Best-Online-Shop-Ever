import type { OutgoingEmail } from "../types.js";

/**
 * "Your account data was exported" notification.
 *
 * Sent AFTER a successful self-service data export (GDPR Art. 15 right of
 * access + Art. 20 right to data portability), the moment the export payload
 * is generated and handed to the requester.
 *
 * Why notify at all? The export bundles the entirety of a customer's personal
 * data into one machine-readable file. If a session is hijacked, generating
 * that bundle is one of the highest-value actions an attacker can take — it's
 * a one-shot exfiltration of everything we hold about the victim. An
 * out-of-band "this just happened" notice gives the legitimate owner a
 * real-time tripwire and a clear next step, exactly like the password-changed
 * notice does for credential rotation.
 *
 * The export file itself is deliberately NOT attached to this email. The
 * requester already received it over the authenticated channel (an in-browser
 * download from the API response). Emailing a second copy of every piece of
 * the customer's PII would (a) widen the attack surface to the mail provider
 * and any inbox forwarders, and (b) defeat the point of the notice — if the
 * inbox is the thing that's compromised, attaching the data hands it straight
 * to the attacker. So this message carries no data and no actionable link;
 * it directs a surprised recipient to secure their account.
 *
 * 2026 best-practice references:
 *   - OWASP Authentication CS, "Notify users of security-sensitive actions"
 *   - GDPR Art. 12 (transparent, intelligible communication to the subject)
 *   - GDPR Art. 5(1)(f) integrity & confidentiality (notice as a detective
 *     control over unauthorised access exercised via a stolen session)
 */

export interface DataExportedTemplateInput {
  to: string;
  fullName?: string | null;
  shopName?: string;
  /** ISO-8601 instant the export was generated. Used in the audit-trail copy. */
  exportedAt?: Date;
  /** Optional support contact, surfaced in the body. */
  supportEmail?: string;
}

export const DATA_EXPORTED_TEMPLATE_ID = "auth.data-exported";

export function renderDataExportedEmail(
  input: DataExportedTemplateInput,
): OutgoingEmail {
  const greeting = input.fullName ? `Здравейте, ${input.fullName}!` : "Здравейте!";
  const shopName = input.shopName ?? "магазина";
  const subject = "Данните на акаунта Ви бяха експортирани";
  const when = input.exportedAt
    ? input.exportedAt.toLocaleString("bg-BG", { timeZone: "Europe/Sofia" })
    : null;
  const support = input.supportEmail ?? null;

  const text = [
    greeting,
    "",
    `Информираме Ви, че от акаунта Ви в ${shopName} беше успешно генериран експорт на личните Ви данни${when ? ` на ${when} (часова зона София)` : ""}.`,
    "",
    "Експортът включва копие на данните, които съхраняваме за Вас, в структуриран, машинно четим формат (JSON) — в изпълнение на правото Ви на достъп (чл. 15 от Общия регламент относно защитата на данните) и правото Ви на преносимост на данните (чл. 20 от ОРЗД).",
    "",
    "От съображения за сигурност файлът с данните НЕ е прикачен към това съобщение. Той беше предоставен директно за изтегляне в браузъра Ви в момента на заявката.",
    "",
    "Ако ВИЕ направихте заявката за експорт, можете спокойно да игнорирате това съобщение.",
    "",
    "Ако НЕ сте заявявали експорт на данните си:",
    "  1. Влезте незабавно в акаунта си и сменете паролата му.",
    "  2. Проверете и защитете имейл акаунта си.",
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
                  Информираме Ви, че от акаунта Ви в ${escapeHtml(shopName)} беше успешно генериран експорт на личните Ви данни${when ? ` на <strong>${escapeHtml(when)}</strong> (часова зона София)` : ""}.
                </p>
                <p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;color:#27272a;">
                  Експортът включва копие на данните, които съхраняваме за Вас, в структуриран, машинно четим формат (JSON) — в изпълнение на правото Ви на достъп (чл. 15 от ОРЗД) и правото Ви на преносимост на данните (чл. 20 от ОРЗД).
                </p>
                <p style="margin:0 0 24px 0;font-size:15px;line-height:1.6;color:#27272a;">
                  От съображения за сигурност файлът с данните <strong>не е прикачен</strong> към това съобщение — той беше предоставен директно за изтегляне в браузъра Ви в момента на заявката.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 24px 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#fef2f2;border:1px solid #fecaca;border-radius:6px;">
                  <tr>
                    <td style="padding:16px 20px;">
                      <p style="margin:0 0 8px 0;font-size:14px;font-weight:600;color:#991b1b;">
                        Ако НЕ сте заявявали експорт на данните си:
                      </p>
                      <ol style="margin:0;padding-left:20px;font-size:13px;line-height:1.6;color:#7f1d1d;">
                        <li>Влезте незабавно в акаунта си и сменете паролата му.</li>
                        <li>Проверете и защитете имейл акаунта си.</li>
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
                  Ако ВИЕ направихте заявката за експорт, можете спокойно да игнорирате това съобщение.
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
    templateId: DATA_EXPORTED_TEMPLATE_ID,
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
