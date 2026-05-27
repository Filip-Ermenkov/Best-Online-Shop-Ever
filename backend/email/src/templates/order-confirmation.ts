import type { OutgoingEmail } from "../types.js";

/**
 * Order confirmation — sent to the customer the moment a `POST /orders`
 * transaction commits.
 *
 * Compliance framing:
 *
 *   - EU Directive 2011/83/EU Art. 8(7) (as it stands after 2023/2673,
 *     mandatory transposition 19 June 2026) obliges the trader to give the
 *     consumer confirmation of the contract concluded, on a durable medium,
 *     within a reasonable time after conclusion and at the latest at the
 *     time of delivery. An email saved in the customer's mailbox is the
 *     canonical "durable medium" example throughout the recitals.
 *   - The confirmation must include all the pre-contract information
 *     required under Art. 6 unless already provided on a durable medium.
 *     This template surfaces: identity of the trader (shopName + support),
 *     main characteristics of the goods (line snapshot), total price
 *     incl. any discount applied, payment / delivery arrangements, and
 *     pointers to the right of withdrawal (the trader is obliged to
 *     mention it — Art. 6(1)(h)).
 *   - 2023/2673 explicitly forbids dark patterns. There is therefore NO
 *     marketing footer, NO upsell row, NO countdown to a delivery slot.
 *
 * Industry-standard 2026 content (Spotler / Omnisend / Braze / Mailtrap):
 *   - Order number first in the subject line, ≤ 50 chars.
 *   - Itemised list with name, quantity, unit price, line total.
 *   - Subtotal / discount / total.
 *   - Delivery arrangement (address for cash_on_delivery, pickup pointer
 *     for pay_at_store).
 *   - Plain "view your order" deep link if available.
 *   - Plain-text fallback every line of the HTML reflects (deliverability).
 *
 * Money handling: amounts arrive as integer cents to keep the template
 * driver-agnostic and float-free. The template formats EUR via
 * `Intl.NumberFormat("bg-BG", { style: "currency", currency: "EUR" })` —
 * the rendered string ("19,99 €") matches Bulgarian convention. We do not
 * assert the exact ICU separator in tests because it varies across Node
 * versions; we assert on the digits.
 */

export type OrderConfirmationPaymentMethod = "cash_on_delivery" | "pay_at_store";

export interface OrderConfirmationLineItem {
  productCode: string;
  productName: string;
  quantity: number;
  /** Snapshot unit price in integer cents. */
  unitPriceCents: number;
}

export interface OrderConfirmationDeliveryAddress {
  city: string;
  postalCode: string;
  street: string;
  apartmentOrOffice?: string | null;
}

export interface OrderConfirmationTemplateInput {
  to: string;
  fullName?: string | null;
  orderNumber: string;
  /** Timestamp the order was placed. Rendered in Europe/Sofia. */
  placedAt: Date;
  paymentMethod: OrderConfirmationPaymentMethod;
  /** Line items in display order. At least one. */
  items: OrderConfirmationLineItem[];
  /** Integer cents. */
  subtotalCents: number;
  /** 0–100. */
  discountPercent: number;
  /** Integer cents. */
  discountAmountCents: number;
  /** Integer cents. */
  totalCents: number;
  /** ISO-4217 code. Defaults to "EUR". */
  currency?: string;
  /** Required when paymentMethod === "cash_on_delivery". Ignored otherwise. */
  deliveryAddress?: OrderConfirmationDeliveryAddress | null;
  /** Absolute deep-link to the order page. Optional — if absent, just the order number is shown. */
  orderUrl?: string;
  shopName?: string;
  supportEmail?: string;
}

export const ORDER_CONFIRMATION_TEMPLATE_ID = "orders.order-confirmation";

export function renderOrderConfirmationEmail(
  input: OrderConfirmationTemplateInput,
): OutgoingEmail {
  if (input.items.length === 0) {
    // Defensive — every order has at least one line by schema invariant.
    // Throwing here keeps a malformed call from producing a confusing
    // email rather than silently rendering an "empty cart receipt".
    throw new Error(
      "renderOrderConfirmationEmail: items must be non-empty",
    );
  }

  const greeting = input.fullName ? `Здравейте, ${input.fullName}!` : "Здравейте!";
  const shopName = input.shopName ?? "магазина";
  const support = input.supportEmail ?? null;
  const currency = (input.currency ?? "EUR").toUpperCase();
  const placedAtFormatted = formatSofiaTimestamp(input.placedAt);
  const subject = `Поръчка ${input.orderNumber} — потвърждение`;

  const paymentMethodLabel =
    input.paymentMethod === "cash_on_delivery"
      ? "Наложен платеж (при доставка)"
      : "Плащане в магазина при получаване";

  const fmtMoney = (cents: number): string => formatMoney(cents, currency);

  // ─── Plain-text body ────────────────────────────────────────────────────
  const lines: string[] = [
    greeting,
    "",
    `Благодарим Ви за поръчката. Потвърждаваме сключения с Вас договор за продажба на стоките по-долу. Това съобщение служи като писмено потвърждение на договора на дълготраен носител по смисъла на чл. 47 от Закона за защита на потребителите (Директива 2011/83/ЕС).`,
    "",
    "Данни за поръчката:",
    `  • Номер на поръчка: ${input.orderNumber}`,
    `  • Дата и час: ${placedAtFormatted} (часова зона Европа/София)`,
    `  • Метод на плащане: ${paymentMethodLabel}`,
  ];

  if (input.paymentMethod === "cash_on_delivery" && input.deliveryAddress) {
    lines.push(`  • Адрес за доставка:`);
    lines.push(`      ${input.deliveryAddress.street}`);
    if (input.deliveryAddress.apartmentOrOffice) {
      lines.push(`      ${input.deliveryAddress.apartmentOrOffice}`);
    }
    lines.push(
      `      ${input.deliveryAddress.postalCode} ${input.deliveryAddress.city}`,
    );
  } else if (input.paymentMethod === "pay_at_store") {
    lines.push(
      `  • Получаване: в магазина. Ще получите второ съобщение, когато поръчката бъде готова за вземане.`,
    );
  }

  lines.push("", "Артикули:");
  for (const it of input.items) {
    const lineTotalCents = it.unitPriceCents * it.quantity;
    lines.push(
      `  • ${it.productName} (код ${it.productCode}) — ${it.quantity} × ${fmtMoney(
        it.unitPriceCents,
      )} = ${fmtMoney(lineTotalCents)}`,
    );
  }

  lines.push("");
  lines.push(`Междинна сума: ${fmtMoney(input.subtotalCents)}`);
  if (input.discountAmountCents > 0) {
    lines.push(
      `Отстъпка (${formatPercent(input.discountPercent)}): −${fmtMoney(input.discountAmountCents)}`,
    );
  }
  lines.push(`ОБЩА СУМА: ${fmtMoney(input.totalCents)}`);

  if (input.orderUrl) {
    lines.push("", `Преглед на поръчката: ${input.orderUrl}`);
  }

  lines.push(
    "",
    `Право на отказ (14 дни): Имате право да се откажете от тази поръчка в срок до 14 дни без да посочвате причина, съгласно чл. 50 от Закона за защита на потребителите (Директива 2011/83/ЕС, изменена с Директива 2023/2673). 14-дневният срок започва да тече от датата на приемане на поръчката от страна на търговеца. Можете да упражните правото си на отказ от страницата на поръчката във Вашия профил.`,
  );

  lines.push(
    "",
    support
      ? `За въпроси: ${support}.`
      : `За въпроси, моля свържете се с нас.`,
    "",
    "Запазете това съобщение като писмено доказателство за поръчката.",
    "",
    "Поздрави,",
    `Екипът на ${shopName}`,
  );

  const text = lines.join("\n");

  // ─── HTML body ──────────────────────────────────────────────────────────
  const itemRowsHtml = input.items
    .map((it) => {
      const lineTotal = it.unitPriceCents * it.quantity;
      return `<tr>
                          <td style="padding:10px 0;border-bottom:1px solid #e4e4e7;font-size:14px;color:#27272a;">
                            <div style="font-weight:500;">${escapeHtml(it.productName)}</div>
                            <div style="font-size:12px;color:#71717a;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;">${escapeHtml(it.productCode)}</div>
                          </td>
                          <td style="padding:10px 0;border-bottom:1px solid #e4e4e7;font-size:14px;color:#27272a;text-align:right;white-space:nowrap;">
                            ${it.quantity} × ${escapeHtml(fmtMoney(it.unitPriceCents))}
                          </td>
                          <td style="padding:10px 0 10px 16px;border-bottom:1px solid #e4e4e7;font-size:14px;color:#27272a;text-align:right;white-space:nowrap;font-weight:500;">
                            ${escapeHtml(fmtMoney(lineTotal))}
                          </td>
                        </tr>`;
    })
    .join("");

  const deliveryBlockHtml =
    input.paymentMethod === "cash_on_delivery" && input.deliveryAddress
      ? `<tr>
                          <td style="padding:4px 0;color:#71717a;width:180px;vertical-align:top;">Адрес за доставка:</td>
                          <td style="padding:4px 0;">
                            ${escapeHtml(input.deliveryAddress.street)}<br/>
                            ${
                              input.deliveryAddress.apartmentOrOffice
                                ? `${escapeHtml(input.deliveryAddress.apartmentOrOffice)}<br/>`
                                : ""
                            }
                            ${escapeHtml(input.deliveryAddress.postalCode)} ${escapeHtml(input.deliveryAddress.city)}
                          </td>
                        </tr>`
      : input.paymentMethod === "pay_at_store"
        ? `<tr>
                          <td style="padding:4px 0;color:#71717a;vertical-align:top;">Получаване:</td>
                          <td style="padding:4px 0;">в магазина — ще получите второ съобщение, когато поръчката е готова за вземане.</td>
                        </tr>`
        : "";

  const discountRowHtml =
    input.discountAmountCents > 0
      ? `<tr>
                          <td style="padding:4px 0;color:#71717a;">Отстъпка (${escapeHtml(formatPercent(input.discountPercent))}):</td>
                          <td style="padding:4px 0;text-align:right;color:#15803d;">−${escapeHtml(fmtMoney(input.discountAmountCents))}</td>
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
                  Благодарим Ви за поръчката. Потвърждаваме сключения с Вас договор за продажба на стоките по-долу. Това съобщение служи като писмено потвърждение на договора на <strong>дълготраен носител</strong> по смисъла на чл. 47 от Закона за защита на потребителите (Директива 2011/83/ЕС).
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
                          <td style="padding:4px 0;color:#71717a;">Дата и час:</td>
                          <td style="padding:4px 0;"><strong>${escapeHtml(placedAtFormatted)}</strong><br/><span style="color:#71717a;font-size:12px;">часова зона Европа/София</span></td>
                        </tr>
                        <tr>
                          <td style="padding:4px 0;color:#71717a;">Метод на плащане:</td>
                          <td style="padding:4px 0;">${escapeHtml(paymentMethodLabel)}</td>
                        </tr>
                        ${deliveryBlockHtml}
                      </table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 8px 32px;">
                <h2 style="margin:0 0 12px 0;font-size:16px;font-weight:600;color:#18181b;">Артикули</h2>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size:14px;color:#27272a;">
                  <thead>
                    <tr>
                      <th style="text-align:left;padding:8px 0;border-bottom:2px solid #e4e4e7;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:#52525b;">Артикул</th>
                      <th style="text-align:right;padding:8px 0;border-bottom:2px solid #e4e4e7;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:#52525b;">Кол. × цена</th>
                      <th style="text-align:right;padding:8px 0 8px 16px;border-bottom:2px solid #e4e4e7;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:#52525b;">Сума</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${itemRowsHtml}
                  </tbody>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 32px 24px 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size:14px;color:#27272a;">
                  <tr>
                    <td style="padding:4px 0;color:#71717a;">Междинна сума:</td>
                    <td style="padding:4px 0;text-align:right;">${escapeHtml(fmtMoney(input.subtotalCents))}</td>
                  </tr>
                  ${discountRowHtml}
                  <tr>
                    <td style="padding:8px 0 4px 0;border-top:2px solid #e4e4e7;font-size:15px;font-weight:600;">Обща сума:</td>
                    <td style="padding:8px 0 4px 0;border-top:2px solid #e4e4e7;text-align:right;font-size:15px;font-weight:600;">${escapeHtml(fmtMoney(input.totalCents))}</td>
                  </tr>
                </table>
              </td>
            </tr>
            ${orderUrlBlockHtml}
            <tr>
              <td style="padding:0 32px 24px 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#fafafa;border:1px solid #e4e4e7;border-radius:6px;">
                  <tr>
                    <td style="padding:16px 20px;">
                      <p style="margin:0 0 8px 0;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:#52525b;">
                        Право на отказ (14 дни)
                      </p>
                      <p style="margin:0;font-size:13px;line-height:1.6;color:#52525b;">
                        Имате право да се откажете от тази поръчка в срок до 14 дни без да посочвате причина, съгласно чл. 50 от Закона за защита на потребителите (Директива 2011/83/ЕС, изменена с Директива 2023/2673). 14-дневният срок започва да тече от датата на приемане на поръчката от страна на търговеца. Можете да упражните правото си на отказ от страницата на поръчката във Вашия профил.
                      </p>
                    </td>
                  </tr>
                </table>
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
            <tr>
              <td style="padding:0 32px 32px 32px;">
                <p style="margin:0;font-size:13px;line-height:1.6;color:#71717a;">
                  Запазете това съобщение като писмено доказателство за поръчката.
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
    templateId: ORDER_CONFIRMATION_TEMPLATE_ID,
  };
}

/**
 * Format integer cents as a Bulgarian-locale currency string. Defaults to
 * EUR (the catalog's single currency). The exact separator/space behaviour
 * is left to ICU — tests assert on the digits, not the exact glyphs.
 */
function formatMoney(cents: number, currency: string): string {
  const amount = cents / 100;
  return new Intl.NumberFormat("bg-BG", {
    style: "currency",
    currency,
  }).format(amount);
}

/**
 * Format a 0–100 percent value for display ("10" → "10%", "10.5" → "10,5%").
 * Bulgarian convention uses a comma as decimal separator; the ICU output
 * via `bg-BG` does the right thing.
 */
function formatPercent(percent: number): string {
  if (!Number.isFinite(percent)) return "0%";
  // Strip trailing zeros from the decimal part — "10%" beats "10,00%" for
  // readability.
  const rounded = Math.round(percent * 100) / 100;
  return new Intl.NumberFormat("bg-BG", {
    style: "percent",
    maximumFractionDigits: 2,
  }).format(rounded / 100);
}

/**
 * Format a Date in Europe/Sofia with second-level precision. Same helper
 * as in withdrawal-received — kept local so the template file stays
 * self-contained and identical patterns are obvious side-by-side.
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
