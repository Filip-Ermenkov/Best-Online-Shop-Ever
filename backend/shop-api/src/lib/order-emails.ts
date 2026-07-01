import {
  renderOrderConfirmationEmail,
  renderOrderStatusUpdateEmail,
  type OrderConfirmationDeliveryAddress,
  type OrderConfirmationLineItem,
  type OrderConfirmationPaymentMethod,
  type OrderStatusUpdateStatus,
} from "@shop/email";
import type { Logger } from "pino";
import { getDb } from "./db.js";
import { getEmailTransport } from "./emails.js";
import { parseEnv } from "./env.js";
import { loadShopContact } from "./shop-contact.js";
import { deriveSupportEmail } from "./withdrawal.js";

/**
 * Order-related email sends.
 *
 * The order-confirmation send fires from the `POST /orders` route the
 * moment a checkout transaction commits — it is the durable-medium
 * confirmation of contract conclusion that EU Directive 2011/83/EU
 * (as amended by 2023/2673, mandatory 19 June 2026) obliges the trader
 * to deliver "within a reasonable time after the conclusion of the
 * contract … and at the latest at the time of delivery".
 *
 * The order-status-update send is called by the admin order-management
 * slice (`routes/admin/orders.ts`, POST /admin/orders/:n/status) after
 * each customer-visible transition commits — `accepted`,
 * `ready_for_pickup`, `shipped`, `delivered`, `cancelled`. The
 * `returned` transition is internal bookkeeping and sends nothing (see
 * the template's design notes).
 *
 * Both helpers follow the same posture as the withdrawal helpers:
 *
 *   - Wrap the transport call in try/catch.
 *   - Return `boolean` so the caller can record an audit-trail
 *     "ack timestamp" on success (the orders schema does not have such
 *     a column today — see "future audit column" note in the route).
 *   - Logger is optional and used only for warn-level failure logs;
 *     the helpers themselves NEVER throw.
 */

export interface SendOrderConfirmationInput {
  to: string;
  customerName: string;
  orderNumber: string;
  placedAt: Date;
  paymentMethod: OrderConfirmationPaymentMethod;
  items: OrderConfirmationLineItem[];
  subtotalCents: number;
  discountPercent: number;
  discountAmountCents: number;
  totalCents: number;
  currency?: string;
  deliveryAddress?: OrderConfirmationDeliveryAddress | null;
  /**
   * Override the "view your order" link. Defaults to the account order page
   * (`/account/orders/:n`). Guest orders pass the durable capability URL
   * (`/track/:token`) instead, since a guest has no account page to land on.
   */
  orderUrl?: string;
  logger?: Logger;
}

/**
 * Best-effort send of the order-confirmation email. Returns true iff the
 * transport accepted the message. Caller does NOT fail the order on a
 * `false` — the order is already committed, the customer can retrieve it
 * from `/account/orders`, and the operations team has the log line to
 * follow up. With EMAIL_TRANSPORT=sqs (roadmap item 21, the production
 * target) "accepted" means durably enqueued: the email-fn Lambda retries
 * the actual SES send and parks exhausted messages in an alarmed DLQ.
 */
export async function sendOrderConfirmationEmail(
  input: SendOrderConfirmationInput,
): Promise<boolean> {
  try {
    const env = parseEnv();
    const transport = getEmailTransport();
    const orderUrl =
      input.orderUrl ??
      `${env.PUBLIC_APP_BASE_URL}/account/orders/${encodeURIComponent(input.orderNumber)}`;
    const email = renderOrderConfirmationEmail({
      to: input.to,
      fullName: input.customerName,
      orderNumber: input.orderNumber,
      placedAt: input.placedAt,
      paymentMethod: input.paymentMethod,
      items: input.items,
      subtotalCents: input.subtotalCents,
      discountPercent: input.discountPercent,
      discountAmountCents: input.discountAmountCents,
      totalCents: input.totalCents,
      currency: input.currency,
      deliveryAddress: input.deliveryAddress ?? null,
      orderUrl,
      supportEmail: deriveSupportEmail(env.EMAIL_FROM),
    });
    await transport.send(email);
    return true;
  } catch (err) {
    input.logger?.warn(
      { err, orderNumber: input.orderNumber },
      "order_confirmation_email_failed",
    );
    return false;
  }
}

export interface SendOrderStatusUpdateInput {
  to: string;
  customerName: string;
  orderNumber: string;
  status: OrderStatusUpdateStatus;
  changedAt: Date;
  courierCompany?: string | null;
  trackingNumber?: string | null;
  pickupDeadline?: Date | null;
  cancelledReason?: string | null;
  /**
   * Override the "view your order" link (see SendOrderConfirmationInput). Guest
   * orders pass the `/track/:token` capability URL so the status email reaches
   * the right place. Defaults to the account order page.
   */
  orderUrl?: string;
  logger?: Logger;
}

/**
 * Best-effort send of an order-status-update email. Called by the admin
 * transition route AFTER its transaction commits:
 *
 *     await db.transaction(async (tx) => {
 *       await tx.update(orders).set({ status: nextStatus, ... });
 *       await tx.insert(orderStatusHistory).values({ ... });
 *     });
 *     await sendOrderStatusUpdateEmail({ to, customerName, orderNumber,
 *       status: nextStatus, changedAt: new Date(), logger });
 *
 * Failure to send is logged; the status transition is durable in the DB
 * regardless.
 */
export async function sendOrderStatusUpdateEmail(
  input: SendOrderStatusUpdateInput,
): Promise<boolean> {
  try {
    const env = parseEnv();
    const transport = getEmailTransport();
    const orderUrl =
      input.orderUrl ??
      `${env.PUBLIC_APP_BASE_URL}/account/orders/${encodeURIComponent(input.orderNumber)}`;
    // The "ready for pickup" email must carry the store's address, hours, and
    // phone so the customer knows where/when to collect (spec §"Настройки на
    // магазина" — those values show in the pickup email). Sourced from the
    // admin-editable settings; loaded only for that status, and defensively
    // (a settings glitch must never block the status email itself).
    const shopContact =
      input.status === "ready_for_pickup"
        ? await loadShopContact(getDb()).catch(() => undefined)
        : undefined;
    const email = renderOrderStatusUpdateEmail({
      to: input.to,
      fullName: input.customerName,
      orderNumber: input.orderNumber,
      status: input.status,
      changedAt: input.changedAt,
      courierCompany: input.courierCompany ?? null,
      trackingNumber: input.trackingNumber ?? null,
      pickupDeadline: input.pickupDeadline ?? null,
      cancelledReason: input.cancelledReason ?? null,
      orderUrl,
      supportEmail: deriveSupportEmail(env.EMAIL_FROM),
      shopContact,
    });
    await transport.send(email);
    return true;
  } catch (err) {
    input.logger?.warn(
      { err, orderNumber: input.orderNumber, status: input.status },
      "order_status_update_email_failed",
    );
    return false;
  }
}
