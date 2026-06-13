import type { OutgoingEmail } from "../types.js";

/**
 * Expired-pickup admin notification — sent to the support inbox by the hourly
 * scheduler-fn job when a "ready_for_pickup" order's pickup deadline passes.
 *
 * Per the docs/README.md §7 design intent („Изтекъл срок за вземане —
 * автоматични действия"): the system (1) marks the order visually in the
 * admin panel and (2) emails the administrator with the order number, the
 * customer's details and the fact that the deadline expired. The ORDER IS NOT
 * TRANSITIONED automatically — „Администраторът трябва ръчно да реши дали да
 * откаже поръчката или да се свърже с клиента за нова уговорка."
 *
 * Like the withdrawal admin notification, the body is operations-focused:
 * order number first, customer contact second, suggested actions third — the
 * admin should be able to act from this email without opening another tab,
 * but a deep link to the admin order detail is included for the panel path.
 */

export interface PickupExpiredAdminTemplateInput {
  /** Support inbox address. */
  to: string;
  orderNumber: string;
  /** The deadline that has just been detected as passed. */
  pickupDeadline: Date;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  /** Deep link to the admin order detail (…/admin/orders/<n>). */
  adminOrderUrl: string;
  shopName?: string;
}

export const PICKUP_EXPIRED_ADMIN_TEMPLATE_ID = "orders.pickup-expired-admin";

export function renderPickupExpiredAdminEmail(
  input: PickupExpiredAdminTemplateInput,
): OutgoingEmail {
  const shopName = input.shopName ?? "магазина";
  const deadlineFormatted = formatSofiaTimestamp(input.pickupDeadline);
  const subject = `Изтекъл срок за вземане: поръчка ${input.orderNumber}`;

  const text = [
    `Срокът за вземане на поръчка ${input.orderNumber} изтече, без клиентът да я вземе.`,
    "",
    "Данни за поръчката:",
    `  • Номер на поръчка: ${input.orderNumber}`,
    `  • Краен срок за вземане: ${deadlineFormatted} (Европа/София)`,
    `  • Преглед в панела: ${input.adminOrderUrl}`,
    "",
    "Клиент:",
    `  • Име: ${input.customerName}`,
    `  • Имейл: ${input.customerEmail}`,
    `  • Телефон: ${input.customerPhone}`,
    "",
    "Действия (ръчно решение):",
    "  1. Свържете се с клиента за нова уговорка, или",
    "  2. Откажете поръчката от административния панел.",
    "",
    `— ${shopName}`,
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
              <td style="padding:24px 32px 8px 32px;">
                <h1 style="margin:0;font-size:18px;font-weight:600;color:#18181b;">Изтекъл срок за вземане</h1>
                <p style="margin:8px 0 0 0;font-size:13px;color:#71717a;">
                  Краен срок: <strong>${escapeHtml(deadlineFormatted)}</strong> (Европа/София)
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px 16px 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#fef2f2;border:1px solid #fecaca;border-radius:6px;">
                  <tr>
                    <td style="padding:16px 20px;">
                      <p style="margin:0 0 8px 0;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:#991b1b;">
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
            <tr>
              <td style="padding:0 32px 16px 32px;">
                <h2 style="margin:0 0 12px 0;font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:#52525b;">Действия (ръчно решение)</h2>
                <ol style="margin:0;padding-left:20px;font-size:13px;line-height:1.7;color:#3f3f46;">
                  <li>Свържете се с клиента за нова уговорка, или</li>
                  <li>Откажете поръчката от административния панел.</li>
                </ol>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 24px 32px;">
                <a href="${escapeAttr(input.adminOrderUrl)}" style="display:inline-block;padding:10px 20px;background-color:#18181b;color:#ffffff;border-radius:6px;font-size:14px;font-weight:600;text-decoration:none;">Преглед на поръчката</a>
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
    templateId: PICKUP_EXPIRED_ADMIN_TEMPLATE_ID,
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
