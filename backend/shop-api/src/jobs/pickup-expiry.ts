import { schema } from "@shop/db";
import { and, eq, isNotNull, isNull, lt } from "drizzle-orm";
import type { Logger } from "pino";
import { getDb } from "../lib/db.js";
import { sendPickupExpiredAdminEmail } from "../lib/job-emails.js";

/**
 * Hourly expired-pickup sweep (docs/README.md §7 „Изтекъл срок за вземане").
 *
 * Behaviour mandated by the spec:
 *   1. The order is NOT transitioned — the red marking in the admin panel is
 *      computed from pickup_deadline (already shipped with admin-orders) and
 *      the admin decides manually (cancel or re-arrange).
 *   2. The administrator gets ONE email per expired order with the order
 *      number and the customer's contact details.
 *
 * Idempotency (EventBridge Scheduler is at-least-once, and Lambda async
 * invokes can retry): the job CLAIMS each order by setting
 * pickup_expired_notified_at in the same UPDATE that selects it. A duplicate
 * run finds nothing to claim. If the transport refuses the email, the claim
 * is COMPENSATED (marker reset to NULL) so the next hourly run retries —
 * at-least-once for the notification, with at-most-one send per run.
 *
 * The order row carries the denormalised customer snapshot (name/email/
 * phone), so no joins are needed and a deleted account still notifies
 * correctly.
 */

export interface PickupExpiryResult {
  /** Orders whose marker this run claimed (deadline passed, not yet notified). */
  claimed: number;
  /** Admin notifications accepted by the transport. */
  emailed: number;
}

export async function runPickupExpiryJob(opts?: {
  now?: Date;
  logger?: Logger;
}): Promise<PickupExpiryResult> {
  const db = getDb();
  const now = opts?.now ?? new Date();
  const logger = opts?.logger;

  const claimed = await db
    .update(schema.orders)
    .set({ pickupExpiredNotifiedAt: now })
    .where(
      and(
        eq(schema.orders.status, "ready_for_pickup"),
        isNotNull(schema.orders.pickupDeadline),
        lt(schema.orders.pickupDeadline, now),
        isNull(schema.orders.pickupExpiredNotifiedAt),
      ),
    )
    .returning();

  let emailed = 0;
  for (const order of claimed) {
    const ok = await sendPickupExpiredAdminEmail({
      orderNumber: order.orderNumber,
      // Non-null by the claim predicate; the fallback never fires.
      pickupDeadline: order.pickupDeadline ?? now,
      customerName: order.customerName,
      customerEmail: order.customerEmail,
      customerPhone: order.customerPhone,
      logger,
    });
    if (ok) {
      emailed += 1;
    } else {
      // Compensate: surrender the claim so the next hourly run retries the
      // notification. If THIS write also fails the job throws → Lambda
      // Errors alarm; the claim then stands and the email is skipped — the
      // admin still sees the red expired marking in the panel (the email is
      // the secondary channel).
      await db
        .update(schema.orders)
        .set({ pickupExpiredNotifiedAt: null })
        .where(eq(schema.orders.id, order.id));
      logger?.warn(
        { orderNumber: order.orderNumber },
        "pickup_expiry_claim_compensated",
      );
    }
  }

  return { claimed: claimed.length, emailed };
}
