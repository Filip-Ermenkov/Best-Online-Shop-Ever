/**
 * Guest checkout + order-tracking wire types and error unions.
 *
 * Hand-rolled to mirror the backend DTOs (`routes/guest.ts`: GuestOrderSchema,
 * TrackedOrderSchema, TrackWithdrawalEligibilitySchema, TrackWithdrawalRecord
 * Schema) — same frontend-owns-the-wire-shape convention as lib/orders/types.ts.
 *
 * Money is integer cents throughout.
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

export interface TrackOrderItem {
  productName: string;
  productCode: string;
  productImageUrl: string | null;
  unitPriceCents: number;
  quantity: number;
}

export interface TrackDeliveryAddress {
  city: string;
  postalCode: string;
  street: string;
  apartmentOrOffice: string | null;
}

/** Response of POST /guest/orders. */
export interface GuestOrder {
  orderNumber: string;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  createdAt: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  items: TrackOrderItem[];
  subtotalCents: number;
  discountAmountCents: number;
  totalCents: number;
  currency: string;
  deliveryAddress: TrackDeliveryAddress | null;
  /** The raw capability token — open /track/<token>. */
  trackToken: string;
  trackPath: string;
}

export interface TrackStatusHistoryEntry {
  status: OrderStatus;
  changedAt: string;
}

/** Response of GET /track/:token (and POST /track/:token/cancel). */
export interface TrackedOrder {
  orderNumber: string;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
  createdAt: string;
  acceptedAt: string | null;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  items: TrackOrderItem[];
  subtotalCents: number;
  discountAmountCents: number;
  totalCents: number;
  currency: string;
  deliveryAddress: TrackDeliveryAddress | null;
  courierCompany: string | null;
  trackingNumber: string | null;
  pickupDeadline: string | null;
  statusHistory: TrackStatusHistoryEntry[];
  shopContact: {
    email: string;
    phone: string | null;
    address: string;
    hours: string;
  };
  canCancel: boolean;
}

export type TrackWithdrawalEligibility =
  | {
      eligible: true;
      acceptedAt: string;
      deadlineAt: string;
      alreadySubmittedAt: string | null;
      windowDays: number;
    }
  | {
      eligible: false;
      reason: "not_accepted" | "window_expired";
      windowDays: number;
    };

export interface TrackWithdrawalRecord {
  id: string;
  orderNumber: string;
  reason: string | null;
  submittedAt: string;
  acknowledgedAt: string | null;
}

// ─── Inputs ──────────────────────────────────────────────────────────────────

export interface GuestContactInput {
  email: string;
  name: string;
  phone: string;
}

/** Delivery address as sent to the API (apartmentOrOffice is optional, not null). */
export interface GuestDeliveryAddressInput {
  city: string;
  postalCode: string;
  street: string;
  apartmentOrOffice?: string;
}

export interface GuestPlaceOrderInput {
  contact: GuestContactInput;
  paymentMethod: PaymentMethod;
  deliveryAddress?: GuestDeliveryAddressInput;
  items: { productId: string; quantity: number }[];
  notes?: string;
}

// ─── Error unions ──────────────────────────────────────────────────────────

export type GuestOrderError =
  | { kind: "validation"; fields: { path: string; message: string }[]; detail?: string }
  | { kind: "out_of_stock"; detail?: string; offendingIds: string[] }
  | { kind: "cart_empty"; detail?: string }
  | { kind: "idempotency_conflict"; detail?: string }
  | { kind: "rate_limited"; detail?: string }
  | { kind: "network"; cause: unknown }
  | { kind: "unknown"; status: number; detail?: string };

export type TrackError =
  | { kind: "not_found"; detail?: string }
  | { kind: "not_cancellable"; detail?: string }
  | { kind: "withdrawal_window_expired"; detail?: string }
  | { kind: "withdrawal_not_accepted"; detail?: string }
  | { kind: "rate_limited"; detail?: string }
  | { kind: "network"; cause: unknown }
  | { kind: "unknown"; status: number; detail?: string };

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
export type GuestOrderResult<T> = Result<T, GuestOrderError>;
export type TrackResult<T> = Result<T, TrackError>;
