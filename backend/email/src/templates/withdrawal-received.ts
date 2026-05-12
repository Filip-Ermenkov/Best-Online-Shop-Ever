import type { OutgoingEmail } from "../types.js";

/**
 * Withdrawal acknowledgement — sent to the customer the moment the platform
 * records their 14-day right-of-withdrawal submission.
 *
 * This email is the secondary durable medium required by Article 11a(2) of
 * Directive 2011/83/EU (as amended by Directive 2023/2673 — effective 19
 * June 2026). The primary durable medium is the on-screen acknowledgement
 * rendered by the frontend immediately after submission. This email is
 * defence in depth: if the user closes the tab before reading the
 * confirmation, this is the record they can come back to.
 *
 * Mandatory content per Art. 11a(2):
 *   - the CONTENT of the withdrawal declaration (which order, optional
 *     reason, who submitted);
 *   - the EXACT DATE AND TIME of receipt;
 *   - delivered on a DURABLE MEDIUM (i.e. an email that the user can save,
 *     print or forward — exactly what we do here).
 *
 * The renderer formats the timestamp in Europe/Sofia and the body explicitly
 * names the timezone. Recital 37 prohibits dark patterns; this template
 * therefore contains:
 *   - NO "would you like to cancel your cancellation?" links;
 *   - NO upsell;
 *   - NO countdown to refund pressuring the user;
 *   - NO marketing footer.
 * Just the legally-required receipt + practical next-steps copy.
 */

export interface WithdrawalReceivedTemplateInput {
  to: string;
  fullName?: string | null;
  orderNumber: string;
  /** Timestamp of receipt of the withdrawal declaration. Required. */
  submittedAt: Date;
  /** The customer's optional free-form reason. May be null/empty. */
  description?: string | null;
  shopName?: string;
  supportEmail?: string;
}

export const WITHDRAWAL_RECEIVED_TEMPLATE_ID = "orders.withdrawal-received";

export function renderWithdrawalReceivedEmail(
  input: WithdrawalReceivedTemplateInput,
): OutgoingEmail {
  const greeting = input.fullName ? `Здравейте, ${input.fullName}!` : "Здравейте!";
  const shopName = input.shopName ?? "магазина";
  const submittedAtFormatted = formatSofiaTimestamp(input.submittedAt);
  const support = input.supportEmail ?? null;
  const subject = `Получихме отказа Ви от поръчка ${input.orderNumber}`;
  const description = (input.description ?? "").trim();

  const lines: string[] = [
    greeting,
    "",
    `Потвърждаваме, че получихме Вашата заявка за упражняване на правото на отказ по чл. 50 от Закона за защита на потребителите (14-дневно право на отказ).`,
    "",
    "Данни за заявката:",
    `  • Номер на поръчка: ${input.orderNumber}`,
    `  • Дата и час на получаване: ${submittedAtFormatted} (часова зона Европа/София)`,
  ];
  if (description.length > 0) {
    lines.push(`  • Посочена от Вас причина: ${description}`);
  }
  lines.push(
    "",
    "Какво следва:",
    "  1. Свържете се с нас, за да уговорим връщането на стоката, ако вече сте я получили.",
    "  2. Възстановяването на сумата ще бъде извършено в срок до 14 дни от получаването на стоката обратно (или от получаването на доказателство, че сте я изпратили — което настъпи първо).",
    "  3. Запазете това съобщение като доказателство за подадения отказ.",
    "",
    support
      ? `За въпроси: ${support}.`
      : `За въпроси, моля свържете се с нас.`,
    "",
    "Поздрави,",
    `Екипът на ${shopName}`,
  );
  const text = lines.join("\n");

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
                  Потвърждаваме, че получихме Вашата заявка за упражняване на правото на отказ по чл. 50 от Закона за защита на потребителите (14-дневно право на отказ).
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 24px 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f5;border-radius:6px;">
                  <tr>
                    <td style="padding:16px 20px;">
                      <p style="margin:0 0 8px 0;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:#52525b;">
                        Данни за заявката
                      </p>
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size:14px;line-height:1.6;color:#27272a;">
                        <tr>
                          <td style="padding:4px 0;color:#71717a;width:180px;">Номер на поръчка:</td>
                          <td style="padding:4px 0;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;">${escapeHtml(input.orderNumber)}</td>
                        </tr>
                        <tr>
                          <td style="padding:4px 0;color:#71717a;">Дата и час на получаване:</td>
                          <td style="padding:4px 0;"><strong>${escapeHtml(submittedAtFormatted)}</strong><br/><span style="color:#71717a;font-size:12px;">часова зона Европа/София</span></td>
                        </tr>
                        ${
                          description.length > 0
                            ? `<tr>
                          <td style="padding:4px 0;color:#71717a;vertical-align:top;">Посочена причина:</td>
                          <td style="padding:4px 0;white-space:pre-wrap;">${escapeHtml(description)}</td>
                        </tr>`
                            : ""
                        }
                      </table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 24px 32px;">
                <h2 style="margin:0 0 12px 0;font-size:16px;font-weight:600;color:#18181b;">Какво следва</h2>
                <ol style="margin:0;padding-left:20px;font-size:14px;line-height:1.7;color:#27272a;">
                  <li>Свържете се с нас, за да уговорим връщането на стоката, ако вече сте я получили.</li>
                  <li>Възстановяването на сумата ще бъде извършено в срок до 14 дни от получаването на стоката обратно (или от получаването на доказателство, че сте я изпратили — което настъпи първо).</li>
                  <li>Запазете това съобщение като доказателство за подадения отказ.</li>
                </ol>
              </td>
            </tr>
            ${
              support
                ? `<tr>
              <td style="padding:0 32px 24px 32px;">
                <p style="margin:0;font-size:13px;line-height:1.6;color:#71717a;">
                  За въпроси: <a href="mailto:${escapeAttr(support)}" style="color:#3f3f46;text-decoration:underline;">${escapeHtml(support)}</a>.
                </p>
              </td>
            </tr>`
                : ""
            }
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
    templateId: WITHDRAWAL_RECEIVED_TEMPLATE_ID,
  };
}

/**
 * Format a Date in Europe/Sofia with second-level precision. The Art. 11a
 * obligation is the EXACT date and time of receipt; rendering it in the
 * customer's local-to-shop timezone (rather than UTC) matches the rest of
 * the customer-facing surfaces and is the natural reading for a Bulgarian
 * customer.
 */
function formatSofiaTimestamp(d: Date): string {
  // toLocaleString with bg-BG locale produces e.g. "12.05.2026 г., 14:23:07"
  // — the "г." separator is the Bulgarian convention. We accept the exact
  // ICU output rather than re-formatting it so future locale-data updates
  // do not require code changes.
  return d.toLocaleString("bg-BG", {
    timeZone: "Europe/Sofia",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
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
