import type { OutgoingEmail } from "../types.js";

/**
 * Withdrawal admin notification — sent to the support inbox when a customer
 * submits a 14-day right-of-withdrawal request.
 *
 * Per the README §7 design intent: "Рекламациите не се управляват директно в
 * системата — те само информират администратора чрез имейл. По-нататъшната
 * комуникация и уреждане се извършват извън платформата". The admin's
 * worklist for the next 14 days lives in their mailbox; this email is the
 * single source of truth for follow-up.
 *
 * The body is deliberately operations-focused — order number first, customer
 * contact second, reason third. The support agent should be able to reply to
 * this email and reach the customer without opening any other tab.
 */

export interface WithdrawalAdminNotificationTemplateInput {
  /** Support inbox address. */
  to: string;
  orderNumber: string;
  submittedAt: Date;
  customerEmail: string;
  customerName: string;
  customerPhone: string;
  description?: string | null;
  shopName?: string;
}

export const WITHDRAWAL_ADMIN_NOTIFICATION_TEMPLATE_ID =
  "orders.withdrawal-admin-notification";

export function renderWithdrawalAdminNotificationEmail(
  input: WithdrawalAdminNotificationTemplateInput,
): OutgoingEmail {
  const shopName = input.shopName ?? "магазина";
  const submittedAtFormatted = formatSofiaTimestamp(input.submittedAt);
  const subject = `Отказ от договор: поръчка ${input.orderNumber}`;
  const description = (input.description ?? "").trim();

  const lines: string[] = [
    `Получен е отказ от договор за поръчка ${input.orderNumber}.`,
    "",
    "Данни за заявката:",
    `  • Дата и час: ${submittedAtFormatted} (Европа/София)`,
    `  • Номер на поръчка: ${input.orderNumber}`,
    "",
    "Клиент:",
    `  • Име: ${input.customerName}`,
    `  • Имейл: ${input.customerEmail}`,
    `  • Телефон: ${input.customerPhone}`,
  ];
  if (description.length > 0) {
    lines.push("", "Посочена причина:", description);
  }
  lines.push(
    "",
    "Действия:",
    "  1. Свържете се с клиента в рамките на 24 часа.",
    "  2. Организирайте връщането на стоката.",
    "  3. Възстановете сумата в законоустановения 14-дневен срок.",
    "",
    `— ${shopName}`,
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
              <td style="padding:24px 32px 8px 32px;">
                <h1 style="margin:0;font-size:18px;font-weight:600;color:#18181b;">Отказ от договор</h1>
                <p style="margin:8px 0 0 0;font-size:13px;color:#71717a;">
                  Получено: <strong>${escapeHtml(submittedAtFormatted)}</strong> (Европа/София)
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px 16px 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f5;border-radius:6px;">
                  <tr>
                    <td style="padding:16px 20px;">
                      <p style="margin:0 0 8px 0;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:#52525b;">
                        Поръчка
                      </p>
                      <p style="margin:0;font-size:18px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;color:#18181b;">
                        ${escapeHtml(input.orderNumber)}
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 16px 32px;">
                <h2 style="margin:0 0 12px 0;font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:#52525b;">Клиент</h2>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size:14px;line-height:1.6;color:#27272a;">
                  <tr>
                    <td style="padding:4px 0;color:#71717a;width:120px;">Име:</td>
                    <td style="padding:4px 0;">${escapeHtml(input.customerName)}</td>
                  </tr>
                  <tr>
                    <td style="padding:4px 0;color:#71717a;">Имейл:</td>
                    <td style="padding:4px 0;"><a href="mailto:${escapeAttr(input.customerEmail)}" style="color:#3f3f46;text-decoration:underline;">${escapeHtml(input.customerEmail)}</a></td>
                  </tr>
                  <tr>
                    <td style="padding:4px 0;color:#71717a;">Телефон:</td>
                    <td style="padding:4px 0;"><a href="tel:${escapeAttr(input.customerPhone)}" style="color:#3f3f46;text-decoration:underline;">${escapeHtml(input.customerPhone)}</a></td>
                  </tr>
                </table>
              </td>
            </tr>
            ${
              description.length > 0
                ? `<tr>
              <td style="padding:0 32px 16px 32px;">
                <h2 style="margin:0 0 12px 0;font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:#52525b;">Посочена причина</h2>
                <div style="padding:12px 16px;background-color:#fafafa;border:1px solid #e4e4e7;border-radius:6px;font-size:14px;line-height:1.6;color:#27272a;white-space:pre-wrap;">${escapeHtml(description)}</div>
              </td>
            </tr>`
                : ""
            }
            <tr>
              <td style="padding:0 32px 24px 32px;">
                <h2 style="margin:0 0 12px 0;font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:#52525b;">Действия</h2>
                <ol style="margin:0;padding-left:20px;font-size:13px;line-height:1.7;color:#3f3f46;">
                  <li>Свържете се с клиента в рамките на 24 часа.</li>
                  <li>Организирайте връщането на стоката.</li>
                  <li>Възстановете сумата в законоустановения 14-дневен срок.</li>
                </ol>
              </td>
            </tr>
          </table>
          <p style="margin:16px 0 0 0;font-size:12px;color:#a1a1aa;">
            Това съобщение е автоматично известие от ${escapeHtml(shopName)}.
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
    templateId: WITHDRAWAL_ADMIN_NOTIFICATION_TEMPLATE_ID,
  };
}

function formatSofiaTimestamp(d: Date): string {
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
