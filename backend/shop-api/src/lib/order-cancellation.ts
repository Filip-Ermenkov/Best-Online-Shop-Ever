import { schema, type DbClient } from "@shop/db";
import { eq } from "drizzle-orm";

/**
 * Customer-/guest-initiated order cancellation ("Анулиране от клиента / госта",
 * `docs/README.md` §7).
 *
 * This is a DIFFERENT policy from the admin "Откажи поръчката" action (which
 * lives in the admin FSM `lib/order-status.ts` and may also cancel a
 * `ready_for_pickup` order). The consumer-facing rule is stricter and uniform
 * across payment methods: a customer or guest may cancel ONLY while the order
 * is still `processing` ("Обработва се"). After it moves on, the spec says the
 * only path is to phone the shop — so this op refuses anything else.
 *
 * Concurrency: the cancel runs inside a transaction that re-reads the row
 * `FOR UPDATE`. If an admin transition (e.g. processing → shipped) commits
 * first, our locked re-read sees the new status and we return
 * `not_cancellable` — the stale cancel never lands. This is the same row-lock
 * pattern checkout and the admin transition use, so we don't need a
 * client-supplied `expectedVersion` here; the lock + status re-check is the
 * authority. We still bump `version` so any optimistic-locked admin tab open
 * on the order refreshes.
 *
 * Shared by the authenticated route (`POST /orders/:orderNumber/cancel`) and
 * the guest route (`POST /track/:token/cancel`); the caller resolves the order
 * (by owner or by token) and passes its id + the acting user id (null = guest).
 */

export type OrderStatus =
  | "processing"
  | "shipped"
  | "ready_for_pickup"
  | "delivered"
  | "accepted"
  | "returned"
  | "cancelled";

/** Pure guard — the single source of truth for "can the customer cancel now?". */
export function isCustomerCancellableStatus(status: OrderStatus): boolean {
  return status === "processing";
}

export type CancelOrderResult =
  | { ok: true; order: typeof schema.orders.$inferSelect }
  | { ok: false; reason: "not_found" | "not_cancellable"; status?: OrderStatus };

export interface CancelOrderInput {
  orderId: string;
  /** Acting user id, or null for a guest acting via the tracking token. */
  actorUserId: string | null;
  /** Human-readable reason stored on the order + history note. */
  reason: string;
}

/**
 * Transition an order to `cancelled` on behalf of the customer/guest, atomically
 * writing the `order_status_history` audit row. Returns a discriminated result
 * the route maps to HTTP (404 / 422 / 200). Never throws on the business-rule
 * paths — only a genuine DB fault propagates.
 */
export async function cancelOrderByCustomer(
  db: DbClient,
  input: CancelOrderInput,
): Promise<CancelOrderResult> {
  return db.transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, input.orderId))
      .for("update");

    if (!order) return { ok: false as const, reason: "not_found" as const };

    if (!isCustomerCancellableStatus(order.status as OrderStatus)) {
      return {
        ok: false as const,
        reason: "not_cancellable" as const,
        status: order.status as OrderStatus,
      };
    }

    const [updated] = await tx
      .update(schema.orders)
      .set({
        status: "cancelled",
        cancelledReason: input.reason,
        version: order.version + 1,
      })
      .where(eq(schema.orders.id, input.orderId))
      .returning();

    if (!updated) return { ok: false as const, reason: "not_found" as const };

    await tx.insert(schema.orderStatusHistory).values({
      orderId: input.orderId,
      status: "cancelled",
      changedByUserId: input.actorUserId,
      note: input.reason,
    });

    return { ok: true as const, order: updated };
  });
}
