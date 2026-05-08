/**
 * Shared order types — wire shapes and a discriminated error union.
 *
 * The "wire" shapes mirror the backend's `OrderSchema` in
 * backend/shop-api/src/routes/orders.ts. Hand-rolled (not imported from
 * @shop/api) for the same reason as auth/cart: the Hono RPC types describe
 * the wire shape but a frontend-owned interface is clearer to refactor.
 *
 * Money is integer cents throughout (subtotalCents, totalCents, …) — the
 * backend stores numeric(10,0) / numeric(12,0) and serialises as Number.
 * Numbers up to ~9 ×10¹⁵ are exactly representable, far above any realistic
 * basket total, so JS `number` is safe end-to-end.
 */

export type OrderStatus =
  | "processing"
  | "shipped"
  | "ready_for_pickup"
  | "delivered"
  | "accepted"
  | "returned"
  | "cancelled";

export type PaymentMethod = "cash_on_delivery" | "pay_at_store";

export interface OrderItem {
  /** Null only if the source product was hard-deleted post-order. */
  productId: string | null;
  productCode: string;
  productName: string;
  productImageUrl: string | null;
  /** Snapshot price at placement time. Survives later catalog edits. */
  unitPriceCents: number;
  quantity: number;
  discountAmountCents: number;
}

export interface OrderDeliveryAddress {
  city: string;
  postalCode: string;
  street: string;
  apartmentOrOffice: string | null;
}

export interface OrderCorporateData {
  companyName: string;
  eik: string;
  vatNumber: string | null;
  registeredAddress: string;
  mol: string;
  contactName: string;
}

export interface OrderDTO {
  id: string;
  /** Public order number (e.g. "2026-05-00123"). Used in URLs. */
  orderNumber: string;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  customerEmail: string;
  customerName: string;
  customerPhone: string;
  subtotalCents: number;
  /** 0–100. */
  discountPercent: number;
  discountAmountCents: number;
  totalCents: number;
  currency: string;
  items: OrderItem[];
  /** Present only for cash_on_delivery orders. */
  deliveryAddress: OrderDeliveryAddress | null;
  /** Present only for corporate accounts. */
  corporateData: OrderCorporateData | null;
  notes: string | null;
  createdAt: string;
}

export interface PlaceOrderInput {
  paymentMethod: PaymentMethod;
  /** Required when paymentMethod === "cash_on_delivery". */
  deliveryAddress?: {
    city: string;
    postalCode: string;
    street: string;
    apartmentOrOffice?: string;
  };
  notes?: string;
}

/**
 * Discriminated union over every error path the order endpoints can produce.
 *
 * Why a typed union and not a plain Error? The UI's submit handler has to
 * branch on the *kind* of failure to render the right Bulgarian copy and
 * decide whether to retry / regenerate the idempotency key / bounce to
 * login / clear the cart. A discriminated union makes that branching
 * exhaustive at the type level — TypeScript will flag a missed case.
 *
 *   - validation:           400. Bad body shape (missing deliveryAddress, etc.).
 *   - unauthenticated:      401. Cookie expired between page load and submit.
 *   - email_not_verified:   403. /problems/email-not-verified.
 *   - out_of_stock:         409. /problems/out-of-stock. errors[] carries codes.
 *   - idempotency_conflict: 409. /problems/idempotency-conflict (cross-customer).
 *   - cart_empty:           422. /problems/cart-empty (every line soft-deleted).
 *   - profile_required:     422. /problems/profile-required (admin / new account).
 *   - not_found:            404. (GET /orders/:n only — wrong number or someone else's.)
 *   - network:              fetch threw (offline, DNS).
 *   - unknown:              everything else — render generic banner.
 */
export type OrderError =
  | {
      kind: "validation";
      fields: { path: string; message: string }[];
      detail?: string;
    }
  | { kind: "unauthenticated"; detail?: string }
  | { kind: "email_not_verified"; detail?: string }
  | {
      kind: "out_of_stock";
      detail?: string;
      /** Product codes that the backend flagged as offending. */
      offendingCodes: string[];
    }
  | { kind: "idempotency_conflict"; detail?: string }
  | { kind: "cart_empty"; detail?: string }
  | { kind: "profile_required"; detail?: string }
  | { kind: "not_found"; detail?: string }
  | { kind: "network"; cause?: unknown }
  | { kind: "unknown"; status: number; detail?: string };

export type OrderResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: OrderError };
