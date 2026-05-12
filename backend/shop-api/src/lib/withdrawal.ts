import { schema, type DbClient } from "@shop/db";
import { and, eq, sql } from "drizzle-orm";
import type { Logger } from "pino";
import {
  renderWithdrawalReceivedEmail,
  renderWithdrawalAdminNotificationEmail,
} from "@shop/email";
import { getEmailTransport } from "./emails.js";
import { parseEnv } from "./env.js";

/**
 * Withdrawal slice — eligibility, persistence, durable-medium acknowledgement.
 *
 * Implements the customer-facing half of the EU 14-day right of withdrawal as
 * amended by Directive 2023/2673 / Art. 11a of 2011/83/EU — the "withdrawal
 * button" obligation that becomes mandatory on 19 June 2026.
 *
 * Design rules baked into the helpers below:
 *
 *   - **Window**: 14 calendar days from the moment the order moved to status
 *     `accepted`. We trust `orders.accepted_at` rather than re-reading the
 *     status history; the schema invariant is that the column is populated
 *     iff the row is in `accepted` status. If status is `accepted` but
 *     `accepted_at` is unexpectedly NULL we treat the order as INELIGIBLE
 *     — the broken invariant should not silently grant a withdrawal.
 *
 *   - **One per order**: a partial unique index on the complaints table
 *     enforces "one withdrawal per order at the DB level". Re-submission is
 *     idempotent: the helper INSERTs with ON CONFLICT DO NOTHING and then
 *     reads back the existing row. Same record, same submitted_at,
 *     same acknowledgement timestamp — no duplicate emails.
 *
 *   - **Durable-medium snapshot**: customer_email/name/phone are denormalised
 *     onto the complaints row at submission time so the audit trail survives
 *     subsequent profile edits AND so a future admin-side workflow can render
 *     the submission without re-joining a possibly-anonymised user record.
 *
 *   - **Best-effort email**: the on-screen acknowledgement IS the primary
 *     durable medium (recital 37 of 2023/2673 — the consumer must "receive"
 *     the acknowledgement, not have it survive their device's failures).
 *     The email is defence in depth. If the SES send fails, we still return
 *     a successful response with the submitted record — `acknowledgedAt`
 *     stays NULL and the support team handles the manual notification.
 *
 *   - **No dark patterns**: there is no "are you sure?" double confirmation,
 *     no countdown timer, no "would you like to keep the goods at half
 *     price?" interstitial. Recital 37 specifically prohibits these.
 *     Submission is one click of one button.
 */

const WITHDRAWAL_WINDOW_DAYS = 14;
const WITHDRAWAL_WINDOW_MS = WITHDRAWAL_WINDOW_DAYS * 24 * 60 * 60 * 1000;

export type WithdrawalEligibility =
  | {
      eligible: true;
      orderId: string;
      orderNumber: string;
      acceptedAt: Date;
      /** Inclusive deadline. Submissions at or before this instant are valid. */
      deadlineAt: Date;
      alreadySubmittedAt: Date | null;
    }
  | {
      eligible: false;
      reason:
        | "order_not_found"
        | "not_accepted"
        | "missing_accepted_at"
        | "window_expired";
    };

export interface EvaluateWithdrawalEligibilityInput {
  userId: string;
  orderNumber: string;
  /** Defaults to `new Date()`. Injectable so tests can pin time. */
  now?: Date;
}

/**
 * Read-only eligibility check. Returns enough information to either render
 * the "Withdraw" button + deadline (`eligible: true`) or render the right
 * disabled state without leaking unrelated info (`eligible: false`).
 *
 * The "order belongs to this user" filter is part of the lookup — orders
 * owned by other users return `order_not_found`, identical to truly absent
 * orders. This matches the rest of the orders API's enumeration-resistant
 * stance.
 */
export async function evaluateWithdrawalEligibility(
  db: DbClient,
  input: EvaluateWithdrawalEligibilityInput,
): Promise<WithdrawalEligibility> {
  const now = input.now ?? new Date();

  const [order] = await db
    .select({
      id: schema.orders.id,
      orderNumber: schema.orders.orderNumber,
      status: schema.orders.status,
      acceptedAt: schema.orders.acceptedAt,
    })
    .from(schema.orders)
    .where(
      and(
        eq(schema.orders.orderNumber, input.orderNumber),
        eq(schema.orders.customerId, input.userId),
      ),
    )
    .limit(1);

  if (!order) return { eligible: false, reason: "order_not_found" };
  if (order.status !== "accepted")
    return { eligible: false, reason: "not_accepted" };
  if (!order.acceptedAt)
    return { eligible: false, reason: "missing_accepted_at" };

  const deadlineAt = new Date(order.acceptedAt.getTime() + WITHDRAWAL_WINDOW_MS);

  // Pre-fetch existing withdrawal so the caller can short-circuit to the
  // idempotent-success path without a second round-trip.
  const [existing] = await db
    .select({ submittedAt: schema.complaints.submittedAt })
    .from(schema.complaints)
    .where(
      and(
        eq(schema.complaints.orderId, order.id),
        eq(schema.complaints.reason, "withdrawal"),
      ),
    )
    .limit(1);

  if (now.getTime() > deadlineAt.getTime()) {
    // Window is over. If a withdrawal was filed inside the window, the
    // record still exists (and the API still returns it), but the
    // "request" action is no longer valid. We surface this as window_expired
    // — the caller decides whether to expose the existing row.
    return existing?.submittedAt
      ? {
          eligible: true,
          orderId: order.id,
          orderNumber: order.orderNumber,
          acceptedAt: order.acceptedAt,
          deadlineAt,
          alreadySubmittedAt: existing.submittedAt,
        }
      : { eligible: false, reason: "window_expired" };
  }

  return {
    eligible: true,
    orderId: order.id,
    orderNumber: order.orderNumber,
    acceptedAt: order.acceptedAt,
    deadlineAt,
    alreadySubmittedAt: existing?.submittedAt ?? null,
  };
}

export interface WithdrawalRecord {
  id: string;
  orderId: string;
  customerEmail: string;
  customerName: string;
  customerPhone: string;
  description: string | null;
  submittedAt: Date;
  acknowledgedAt: Date | null;
}

export interface CreateWithdrawalRecordInput {
  orderId: string;
  customerEmail: string;
  customerName: string;
  customerPhone: string;
  description: string | null;
}

/**
 * Create-or-fetch a withdrawal record idempotently.
 *
 * Returns:
 *   - The newly-inserted record on the happy path (`created: true`).
 *   - The existing record if a withdrawal already exists for this order
 *     (`created: false`). The partial unique index
 *     `complaints_order_withdrawal_unique` enforces this at the DB level;
 *     the helper does NOT race-check separately.
 *
 * Uses raw SQL because Drizzle 0.36's `onConflictDoNothing({ target, where })`
 * has known driver-specific quirks for partial-unique-index conflict targets
 * (the same pain point that pushed `ensureCartExists` to raw SQL in cart.ts).
 * The raw form sidesteps that entirely and works identically on neon-http
 * and node-pg.
 */
export async function createOrFetchWithdrawalRecord(
  db: DbClient,
  input: CreateWithdrawalRecordInput,
): Promise<{ record: WithdrawalRecord; created: boolean }> {
  const result = await db.execute(sql`
    INSERT INTO complaints (
      order_id,
      reason,
      description,
      customer_email,
      customer_name,
      customer_phone
    ) VALUES (
      ${input.orderId}::uuid,
      'withdrawal',
      ${input.description},
      ${input.customerEmail},
      ${input.customerName},
      ${input.customerPhone}
    )
    ON CONFLICT (order_id) WHERE reason = 'withdrawal' DO NOTHING
    RETURNING id, order_id, customer_email, customer_name, customer_phone,
              description, submitted_at, acknowledged_at
  `);

  const row = pickFirstRow<{
    id: string;
    order_id: string;
    customer_email: string | null;
    customer_name: string | null;
    customer_phone: string | null;
    description: string | null;
    submitted_at: Date | string;
    acknowledged_at: Date | string | null;
  }>(result);

  if (row) {
    return {
      created: true,
      record: {
        id: row.id,
        orderId: row.order_id,
        customerEmail: row.customer_email ?? input.customerEmail,
        customerName: row.customer_name ?? input.customerName,
        customerPhone: row.customer_phone ?? input.customerPhone,
        description: row.description,
        submittedAt: toDate(row.submitted_at),
        acknowledgedAt: row.acknowledged_at ? toDate(row.acknowledged_at) : null,
      },
    };
  }

  // ON CONFLICT DO NOTHING → 0 rows returned. Re-read the existing row.
  const existing = await fetchWithdrawalByOrderId(db, input.orderId);
  if (!existing) {
    // Pathological: the unique constraint fired but we can't read it back.
    // Should never happen; throw rather than silently lose the record.
    throw new Error(
      `Withdrawal insert conflict on order ${input.orderId} but no existing row found.`,
    );
  }
  return { created: false, record: existing };
}

/**
 * Driver-portable first-row pick. neon-http returns the rows array directly;
 * node-pg returns { rows: [...] }. Mirrors the helper in routes/orders.ts.
 */
function pickFirstRow<T>(result: unknown): T | null {
  if (Array.isArray(result)) return (result[0] as T | undefined) ?? null;
  const r = result as { rows?: unknown[] } | null | undefined;
  if (r && Array.isArray(r.rows)) return (r.rows[0] as T | undefined) ?? null;
  return null;
}

/** Coerce a driver-returned timestamp (Date | string) to a Date. */
function toDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}

export async function fetchWithdrawalByOrderId(
  db: DbClient,
  orderId: string,
): Promise<WithdrawalRecord | null> {
  const [row] = await db
    .select({
      id: schema.complaints.id,
      orderId: schema.complaints.orderId,
      customerEmail: schema.complaints.customerEmail,
      customerName: schema.complaints.customerName,
      customerPhone: schema.complaints.customerPhone,
      description: schema.complaints.description,
      submittedAt: schema.complaints.submittedAt,
      acknowledgedAt: schema.complaints.acknowledgedAt,
    })
    .from(schema.complaints)
    .where(
      and(
        eq(schema.complaints.orderId, orderId),
        eq(schema.complaints.reason, "withdrawal"),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    orderId: row.orderId,
    // The columns are nullable at the schema level for cross-kind reuse
    // but the app layer guarantees they're populated for withdrawal rows.
    customerEmail: row.customerEmail ?? "",
    customerName: row.customerName ?? "",
    customerPhone: row.customerPhone ?? "",
    description: row.description,
    submittedAt: row.submittedAt,
    acknowledgedAt: row.acknowledgedAt,
  };
}

/**
 * Set acknowledged_at = now() on a withdrawal row. Called from the route
 * handler after a successful customer-acknowledgement email send. Best-effort
 * itself — if this UPDATE fails the user still got their record + email and
 * the audit trail just stays NULL.
 */
export async function markWithdrawalAcknowledged(
  db: DbClient,
  withdrawalId: string,
): Promise<Date | null> {
  // Raw SQL because Drizzle 0.36's `.returning({ col: schema.table.col })`
  // collapses on the DbClient union — TS intersects the two driver branches
  // and ends up at the no-arg overload signature. The raw form sidesteps
  // that entirely and is identical in behaviour. Same pattern is used
  // elsewhere in this codebase for narrow-`returning` shapes.
  const result = await db.execute(sql`
    UPDATE complaints
       SET acknowledged_at = now()
     WHERE id = ${withdrawalId}::uuid
     RETURNING acknowledged_at
  `);
  const row = pickFirstRow<{ acknowledged_at: Date | string | null }>(result);
  if (!row || !row.acknowledged_at) return null;
  return toDate(row.acknowledged_at);
}

export interface SendWithdrawalAcknowledgementInput {
  to: string;
  customerName: string;
  orderNumber: string;
  submittedAt: Date;
  description: string | null;
  logger?: Logger;
}

/**
 * Best-effort send of the customer-facing acknowledgement. Returns true iff
 * the transport accepted it. Caller uses the result to decide whether to
 * update `acknowledged_at`.
 */
export async function sendWithdrawalAcknowledgementEmail(
  input: SendWithdrawalAcknowledgementInput,
): Promise<boolean> {
  try {
    const env = parseEnv();
    const transport = getEmailTransport();
    const email = renderWithdrawalReceivedEmail({
      to: input.to,
      fullName: input.customerName,
      orderNumber: input.orderNumber,
      submittedAt: input.submittedAt,
      description: input.description,
      supportEmail: deriveSupportEmail(env.EMAIL_FROM),
    });
    await transport.send(email);
    // Transports throw on permanent errors and retry internally on transient
    // ones — a resolved promise means SES (or the stub) accepted the message.
    return true;
  } catch (err) {
    input.logger?.warn(
      { err, orderNumber: input.orderNumber },
      "withdrawal acknowledgement email send threw",
    );
    return false;
  }
}

export interface SendWithdrawalAdminNotificationInput {
  /** Support inbox / admin destination. Derived from EMAIL_FROM in the route. */
  to: string;
  orderNumber: string;
  submittedAt: Date;
  customerEmail: string;
  customerName: string;
  customerPhone: string;
  description: string | null;
  logger?: Logger;
}

/**
 * Best-effort admin notification. Same posture as the customer ack — failure
 * to send is logged but does not block the response.
 */
export async function sendWithdrawalAdminNotificationEmail(
  input: SendWithdrawalAdminNotificationInput,
): Promise<boolean> {
  try {
    const transport = getEmailTransport();
    const email = renderWithdrawalAdminNotificationEmail({
      to: input.to,
      orderNumber: input.orderNumber,
      submittedAt: input.submittedAt,
      customerEmail: input.customerEmail,
      customerName: input.customerName,
      customerPhone: input.customerPhone,
      description: input.description,
    });
    await transport.send(email);
    // Transports throw on permanent errors and retry internally on transient
    // ones — a resolved promise means SES (or the stub) accepted the message.
    return true;
  } catch (err) {
    input.logger?.warn(
      { err, orderNumber: input.orderNumber },
      "withdrawal admin notification email send threw",
    );
    return false;
  }
}

/**
 * Crude derivation of the support inbox from EMAIL_FROM. Identical to the
 * approach used in lib/email-change.ts so behaviour is consistent across
 * slices. The route can override by passing an explicit string instead.
 */
function deriveSupportEmail(emailFrom: string): string {
  // EMAIL_FROM may be "Best Shop <support@example.com>" — extract the addr.
  const match = emailFrom.match(/<([^>]+)>/);
  return match ? match[1]! : emailFrom;
}

export { WITHDRAWAL_WINDOW_DAYS, deriveSupportEmail };
