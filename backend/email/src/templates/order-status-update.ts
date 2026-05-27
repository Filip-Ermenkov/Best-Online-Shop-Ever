import type { OutgoingEmail } from "../types.js";

/**
 * Order status-update — sent to the customer each time the admin transitions
 * an order through one of the customer-visible states.
 *
 * Today the admin-api Lambda (and therefore the route that would fire this)
 * does not exist; admin status transitions happen via direct DB updates
 * (see README "Known gaps" → "Order status update email" and
 * `docs/ARCHITECTURE.md` §15 item 8). The template + helper land here so the
 * future admin-orders slice can wire them in a single line without having
 * to design the copy / compliance language from scratch.
 *
 * Statuses we send for ("customer-visible transitions"):
 *
 *   - `accepted`         — admin confirmed the order. This is the moment the
 *                          14-day right-of-withdrawal window starts running
 *                          (orders.accepted_at), so the body MUST point at
 *                          the withdrawal mechanism (Directive 2023/2673
 *                          Art. 8 / Art. 6(1)(h)).
 *   - `ready_for_pickup` — only meaningful for `pay_at_store` orders. Body
 *                          includes the pickup deadline if provided.
 *   - `shipped`          — only meaningful for `cash_on_delivery` orders.
 *                          Body includes courier + tracking number if
 *                          provided.
 *   - `delivered`        — informational close-out.
 *   - `cancelled`        — order cancelled by admin. Optionally includes the
 *                          admin-provided reason verbatim.
 *
 * Internal-only transitions like `processing` (the seed state) and
 * `returned` (post-withdrawal bookkeeping) do not fire a customer email —
 * the customer is already aware via the on-screen withdrawal flow.
 */

export type OrderStatusUpdateStatus =
  | "accepted"
  | "ready_for_pickup"
  | "shipped"
  | "delivered"
  | "cancelled";

export interface OrderStatusUpdateTemplateInput {
  to: string;
  fullName?: string | null;
  orderNumber: string;
  status: OrderStatusUpdateStatus;
  /** Timestamp the status transition was recorded. Rendered in Europe/Sofia. */
  changedAt: Date;
  /** Required when status === "shipped" and the admin filled it in. */
  courierCompany?: string | null;
  /** Required when status === "shipped" and the admin filled it in. */
  trackingNumber?: string | null;
  /**
   * Required when status === "ready_for_pickup" and the admin filled in a
   * deadline. Rendered as a Europe/Sofia date.
   */
  pickupDeadline?: Date | null;
  /** Optional when status === "cancelled". */
  cancelledReason?: string | null;
  /** Absolute deep-link to the order page. Optional but encouraged. */
  orderUrl?: string;
  shopName?: string;
  supportEmail?: string;
}

export const ORDER_STATUS_UPDATE_TEMPLATE_ID = "orders.order-status-update";

export function renderOrderStatusUpdateEmail(
  input: OrderStatusUpdateTemplateInput,
): OutgoingEmail {
  const greeting = input.fullName ? `Здравейте, ${input.fullName}!` : "Здравейте!";
  const shopName = input.shopName ?? "магазина";
  const support = input.supportEmail ?? null;
  const changedAtFormatted = formatSofiaTimestamp(input.changedAt);

  const { subject, statusLabel, body, hint } = describeStatus(input);

  // ─── Plain-text body ────────────────────────────────────────────────────
  const lines: string[] = [
    greeting,
    "",
    body,
    "",
    "Данни за поръчката:",
    `  • Номер на поръчка: ${input.orderNumber}`,
    `  • Нов статус: ${statusLabel}`,
    `  • Дата и час: ${changedAtFormatted} (часова зона Европа/София)`,
  ];

  if (
    input.status === "shipped" &&
    (input.courierCompany || input.trackingNumber)
  ) {
    if (input.courierCompany) {
      lines.push(`  • Куриер: ${input.courierCompany}`);
    }
    if (input.trackingNumber) {
      lines.push(`  • Номер за проследяване: ${input.trackingNumber}`);
    }
  }

  if (input.status === "ready_for_pickup" && input.pickupDeadline) {
    lines.push(`  • Срок за получаване: ${formatSofiaDate(input.pickupDeadline)}`);
  }

  if (input.status === "cancelled" && input.cancelledReason) {
    lines.push(`  • Причина: ${input.cancelledReason}`);
  }

  if (hint) {
    lines.push("", hint);
  }

  if (input.orderUrl) {
    lines.push("", `Преглед на поръчката: ${input.orderUrl}`);
  }

  lines.push(
    "",
    support
      ? `За въпроси: ${support}.`
      : `За въпроси, моля свържете се с нас.`,
    "",
    "Поздрави,",
    `Екипът на ${shopName}`,
  );

  const text = lines.join("\n");

  // ─── HTML body ──────────────────────────────────────────────────────────
  const courierRowsHtml =
    input.status === "shipped" && (input.courierCompany || input.trackingNumber)
      ? `${
          input.courierCompany
            ? `<tr>
                          <td style="padding:4px 0;color:#71717a;width:180px;">Куриер:</td>
                          <td style="padding:4px 0;">${escapeHtml(input.courierCompany)}</td>
                        </tr>`
            : ""
        }${
          input.trackingNumber
            ? `<tr>
                          <td style="padding:4px 0;color:#71717a;">Номер за проследяване:</td>
                          <td style="padding:4px 0;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;">${escapeHtml(input.trackingNumber)}</td>
                        </tr>`
            : ""
        }`
      : "";

  const pickupRowHtml =
    input.status === "ready_for_pickup" && input.pickupDeadline
      ? `<tr>
                          <td style="padding:4px 0;color:#71717a;">Срок за получаване:</td>
                          <td style="padding:4px 0;"><strong>${escapeHtml(formatSofiaDate(input.pickupDeadline))}</strong></td>
                        </tr>`
      : "";

  const cancelledRowHtml =
    input.status === "cancelled" && input.cancelledReason
      ? `<tr>
                          <td style="padding:4px 0;color:#71717a;vertical-align:top;">Причина:</td>
                          <td style="padding:4px 0;white-space:pre-wrap;">${escapeHtml(input.cancelledReason)}</td>
                        </tr>`
      : "";

  const hintBlockHtml = hint
    ? `<tr>
              <td style="padding:0 32px 24px 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#fafafa;border:1px solid #e4e4e7;border-radius:6px;">
                  <tr>
                    <td style="padding:16px 20px;">
                      <p style="margin:0;font-size:13px;line-height:1.6;color:#52525b;">
                        ${escapeHtml(hint)}
                      </p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>`
    : "";

  const orderUrlBlockHtml = input.orderUrl
    ? `<tr>
              <td style="padding:0 32px 24px 32px;text-align:center;">
                <a href="${escapeAttr(input.orderUrl)}" style="display:inline-block;padding:12px 24px;background-color:#18181b;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:500;">
                  Преглед на поръчката
                </a>
              </td>
            </tr>`
    : "";

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
                  ${escapeHtml(body)}
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 24px 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f5;border-radius:6px;">
                  <tr>
                    <td style="padding:16px 20px;">
                      <p style="margin:0 0 8px 0;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:#52525b;">
                        Данни за поръчката
                      </p>
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size:14px;line-height:1.6;color:#27272a;">
                        <tr>
                          <td style="padding:4px 0;color:#71717a;width:180px;">Номер на поръчка:</td>
                          <td style="padding:4px 0;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;">${escapeHtml(input.orderNumber)}</td>
                        </tr>
                        <tr>
                          <td style="padding:4px 0;color:#71717a;">Нов статус:</td>
                          <td style="padding:4px 0;"><strong>${escapeHtml(statusLabel)}</strong></td>
                        </tr>
                        <tr>
                          <td style="padding:4px 0;color:#71717a;">Дата и час:</td>
                          <td style="padding:4px 0;">${escapeHtml(changedAtFormatted)}<br/><span style="color:#71717a;font-size:12px;">часова зона Европа/София</span></td>
                        </tr>
                        ${courierRowsHtml}
                        ${pickupRowHtml}
                        ${cancelledRowHtml}
                      </table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            ${hintBlockHtml}
            ${orderUrlBlockHtml}
            ${
              support
                ? `<tr>
              <td style="padding:0 32px 32px 32px;">
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
    templateId: ORDER_STATUS_UPDATE_TEMPLATE_ID,
  };
}

/**
 * Status-specific copy. Pulled into its own function so the same labels and
 * one-line bodies render identically in both the text and HTML versions.
 *
 * `body` is the lead paragraph (≤ ~2 sentences, no emoji, neutral tone).
 * `hint` is an optional next-step nudge — only present where there is a
 * concrete user action waiting (the 14-day withdrawal window opening,
 * pickup deadline). No marketing.
 */
function describeStatus(input: OrderStatusUpdateTemplateInput): {
  subject: string;
  statusLabel: string;
  body: string;
  hint: string | null;
} {
  switch (input.status) {
    case "accepted":
      return {
        subject: `Поръчка ${input.orderNumber} — приета`,
        statusLabel: "Приета",
        body: `Потвърждаваме, че поръчката Ви беше приета за обработка. От този момент започва да тече 14-дневният Ви срок за отказ съгласно чл. 50 от Закона за защита на потребителите (Директива 2011/83/ЕС, изменена с Директива 2023/2673).`,
        hint: `Можете да упражните правото си на отказ от страницата на поръчката във Вашия профил. Не сте длъжни да посочвате причина.`,
      };
    case "ready_for_pickup":
      return {
        subject: `Поръчка ${input.orderNumber} — готова за получаване`,
        statusLabel: "Готова за получаване",
        body: `Поръчката Ви е готова за получаване в магазина.`,
        hint: input.pickupDeadline
          ? `Моля, заповядайте до посочения срок. След него поръчката може да бъде анулирана.`
          : null,
      };
    case "shipped":
      return {
        subject: `Поръчка ${input.orderNumber} — изпратена`,
        statusLabel: "Изпратена",
        body: `Поръчката Ви е предадена на куриера и пътува към адреса за доставка.`,
        hint: null,
      };
    case "delivered":
      return {
        subject: `Поръчка ${input.orderNumber} — доставена`,
        statusLabel: "Доставена",
        body: `Регистрирахме, че поръчката Ви е доставена. Благодарим Ви за доверието.`,
        hint: null,
      };
    case "cancelled":
      return {
        subject: `Поръчка ${input.orderNumber} — анулирана`,
        statusLabel: "Анулирана",
        body: `Съжаляваме, поръчката Ви беше анулирана.`,
        hint: `Ако вече сте платили, ще получите възстановяване в законоустановения срок. За допълнителна информация се свържете с нас.`,
      };
  }
}

/**
 * Date-only render of a pickup deadline. Hour-precision adds noise when the
 * value is "by end of day on the 5th"; the admin form's UX is day-level too.
 */
function formatSofiaDate(d: Date): string {
  return d.toLocaleString("bg-BG", {
    timeZone: "Europe/Sofia",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

/**
 * Match the second-precision Sofia timestamp used by withdrawal-received and
 * order-confirmation so the audit-style headers line up across the suite.
 */
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
