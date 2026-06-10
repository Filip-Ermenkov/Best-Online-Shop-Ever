/**
 * Order-status state machine — the single authoritative encoding of the
 * lifecycle diagram in docs/README.md §7 ("Жизнен цикъл на поръчката").
 *
 * Why a standalone pure module (no DB, no HTTP):
 *
 *   - The admin transition route, the future scheduler-fn (pickup-expiry
 *     handling), and the frontend's action buttons all need the SAME answer
 *     to "what may follow status X for payment method Y". Encoding it once
 *     server-side keeps the API the source of truth; the frontend mirrors it
 *     for button rendering but the server re-validates every request.
 *   - Industry practice for order-management state machines (commercetools
 *     state-machine guidance, classic FSM design) is to define the FULL
 *     transition table explicitly — never "any status → any status" — so an
 *     invalid hop (e.g. `accepted → shipped`) is structurally impossible
 *     rather than a forgotten if-branch.
 *
 * The table below is a 1:1 transcription of the spec's
 * "Действия на администратора по статус" matrix:
 *
 *   processing       → shipped            (cash_on_delivery only)
 *   processing       → ready_for_pickup   (pay_at_store only)
 *   processing       → cancelled          (both)
 *   shipped          → delivered          (cash_on_delivery only)
 *   ready_for_pickup → accepted           (pay_at_store only — pickup taken)
 *   ready_for_pickup → cancelled          (both — no-show / late refusal)
 *   delivered        → accepted           (cash_on_delivery only)
 *   delivered        → returned           (cash_on_delivery only)
 *   accepted / returned / cancelled       → ∅ (terminal)
 *
 * `processing` is never a transition TARGET — it is the seed status written
 * by checkout, and the spec's irreversibility rule ("след потвърждение
 * статусът не може да бъде върнат назад") forbids re-entering it.
 */

export const ORDER_STATUSES = [
  "processing",
  "shipped",
  "ready_for_pickup",
  "delivered",
  "accepted",
  "returned",
  "cancelled",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export type OrderPaymentMethod = "cash_on_delivery" | "pay_at_store";

/** Statuses an admin may transition an order INTO (everything but the seed). */
export const TRANSITION_TARGETS = [
  "shipped",
  "ready_for_pickup",
  "delivered",
  "accepted",
  "returned",
  "cancelled",
] as const;

export type TransitionTarget = (typeof TRANSITION_TARGETS)[number];

/**
 * The transition table. Key = current status; value = the targets reachable
 * from it, each with the payment methods the hop is valid for.
 *
 * Modelled as data (not code) so it can be exhaustively unit-tested and
 * rendered into docs/UI without re-deriving branches.
 */
const TRANSITIONS: Record<
  OrderStatus,
  Partial<Record<TransitionTarget, readonly OrderPaymentMethod[]>>
> = {
  processing: {
    shipped: ["cash_on_delivery"],
    ready_for_pickup: ["pay_at_store"],
    cancelled: ["cash_on_delivery", "pay_at_store"],
  },
  shipped: {
    delivered: ["cash_on_delivery"],
  },
  ready_for_pickup: {
    accepted: ["pay_at_store"],
    cancelled: ["cash_on_delivery", "pay_at_store"],
  },
  delivered: {
    accepted: ["cash_on_delivery"],
    returned: ["cash_on_delivery"],
  },
  // Terminal states — no exits.
  accepted: {},
  returned: {},
  cancelled: {},
};

/** True iff `from → to` is a legal admin transition for this payment method. */
export function canTransition(
  from: OrderStatus,
  to: TransitionTarget,
  paymentMethod: OrderPaymentMethod,
): boolean {
  const methods = TRANSITIONS[from][to];
  return !!methods && methods.includes(paymentMethod);
}

/** Every target legal from `from` for this payment method (UI button list). */
export function allowedTargets(
  from: OrderStatus,
  paymentMethod: OrderPaymentMethod,
): TransitionTarget[] {
  const row = TRANSITIONS[from];
  return (Object.keys(row) as TransitionTarget[]).filter((to) =>
    row[to]!.includes(paymentMethod),
  );
}

/** Terminal = no exits for either payment method. */
export function isTerminal(status: OrderStatus): boolean {
  return Object.keys(TRANSITIONS[status]).length === 0;
}

/**
 * Companion data each target REQUIRES, per the spec's action matrix:
 *
 *   shipped          → courierCompany + trackingNumber (both mandatory — the
 *                      customer email and the tracking page render them)
 *   ready_for_pickup → pickupDeadline (mandatory, must be in the future)
 *   cancelled        → cancelledReason optional (admin courtesy, emailed
 *                      verbatim when present)
 *   everything else  → nothing
 */
export function requiredFieldsForTarget(
  to: TransitionTarget,
): ("courierCompany" | "trackingNumber" | "pickupDeadline")[] {
  switch (to) {
    case "shipped":
      return ["courierCompany", "trackingNumber"];
    case "ready_for_pickup":
      return ["pickupDeadline"];
    default:
      return [];
  }
}

/**
 * Customer-visible transitions that fire the `orders.order-status-update`
 * email (mirror of OrderStatusUpdateStatus in @shop/email — `returned` is
 * internal bookkeeping per the template's design notes and sends nothing).
 */
export function isCustomerNotifiableStatus(
  to: TransitionTarget,
): to is "accepted" | "ready_for_pickup" | "shipped" | "delivered" | "cancelled" {
  return to !== "returned";
}
