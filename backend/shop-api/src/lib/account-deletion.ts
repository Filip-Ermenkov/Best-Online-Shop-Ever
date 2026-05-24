import { randomUUID } from "node:crypto";
import { renderAccountDeletedEmail } from "@shop/email";
import { schema } from "@shop/db";
import { and, eq, inArray } from "drizzle-orm";
import type { Logger } from "pino";
import { getDb } from "./db.js";
import { getEmailTransport } from "./emails.js";
import { parseEnv } from "./env.js";
import { deleteAllSessionsForUser } from "./sessions.js";

/**
 * Account deletion — GDPR Art. 17 (Right to erasure / "right to be forgotten").
 *
 * The implementation balances two binding regimes:
 *
 *   - **GDPR Art. 17(1)**: data subject has the right to obtain erasure of
 *     their personal data "without undue delay". We execute immediately on
 *     request; no soft-undelete grace period (the standard pattern for
 *     SaaS — Stripe, GitHub, Shopify customer accounts).
 *
 *   - **Bulgarian Accountancy Act / Zakon za schetovodstvoto**: 10-year
 *     mandatory retention period for invoices and accounting documents.
 *     Art. 17(3)(b) of GDPR explicitly allows retention to the extent
 *     necessary "for compliance with a legal obligation". The relevant
 *     records are kept; the personal data linking those records to a
 *     specific person is pseudonymised wherever the law doesn't require
 *     the full PII.
 *
 * What we HARD-DELETE (no legal-retention claim):
 *
 *   - customer_profiles / corporate_profiles row — profile data not part
 *     of any invoice record. (The order's customer snapshot is a
 *     separate denormalised copy on the orders row.)
 *   - addresses — address book entries. The delivery-address snapshot on
 *     individual orders is handled separately (pseudonymised on the
 *     order_delivery_address row).
 *   - carts + cart_items — transient pre-purchase data. No legal value.
 *   - discounts — admin-set per-account discount. No invoice value.
 *   - mfa_recovery_codes — single-use auth secrets, no business value
 *     once the account is gone.
 *   - sessions — all of them.
 *   - email_verification_tokens — outstanding signup + email-change
 *     tokens for this user. No remaining purpose.
 *   - password_reset_tokens — same reasoning.
 *   - login_attempts — keyed by email text (not user_id), so we delete
 *     by email match. Art. 5(1)(c) data-minimisation weighs against
 *     retaining authentication telemetry for a user who has exercised
 *     their right to erasure.
 *
 * What we PSEUDONYMISE (Art. 17(3)(b) legal-retention exemption):
 *
 *   - users row — kept (we are NOT hard-deleting). PII columns:
 *       email          → "deleted-<uuid>@deleted.invalid"
 *                        (sentinel chosen so a re-registration of the
 *                        original email succeeds against the unique
 *                        index, AND so the address is non-deliverable
 *                        per RFC 6761 — .invalid is reserved)
 *       password_hash  → set to a non-Argon2 sentinel so even if the
 *                        deletedAt filter is ever bypassed, login still
 *                        fails (defence in depth).
 *       deletedAt      → now()
 *       anonymizedAt   → now()
 *
 *   - orders row — kept (10-year accounting retention). PII columns:
 *       customerId    → set NULL (explicit, since we're not relying on
 *                       the ON DELETE SET NULL FK cascade)
 *       customerEmail → "[deleted]"
 *       customerName  → "[deleted]"
 *       customerPhone → "[deleted]"
 *     The financial fields (subtotal/discount/total) and the
 *     order_items snapshots stay intact — these are the invoice content.
 *
 *   - order_delivery_address rows — kept (delivery address is part of
 *     the contract performance record). PII columns:
 *       street             → "[deleted]"
 *       apartmentOrOffice  → null
 *     We retain city + postal_code as coarse-grained location data
 *     useful for tax-territory analytics; street + apartment are the
 *     identifying fields and are stripped.
 *
 *   - order_corporate_data rows — kept; this IS the invoice party for
 *     B2B orders. Bulgarian VAT law REQUIRES company name + EIK +
 *     registered address + MOL to remain on the invoice. We pseudonymise
 *     only the individual-person field:
 *       contactName  → "[deleted]"
 *
 *   - complaints rows (where the customer was the deleted user) — kept
 *     (Art. 11a of EU 2011/83/EU as amended by 2023/2673 requires the
 *     withdrawal record to persist on a durable medium for the
 *     statutory period). PII columns:
 *       customerEmail → "[deleted]"
 *       customerName  → "[deleted]"
 *       customerPhone → "[deleted]"
 *     The reason enum + description (the substantive complaint
 *     content) stay intact — those are the evidentiary record.
 *
 * Active-order check:
 *
 *   We refuse the deletion if any order is in an active state
 *   (processing / shipped / ready_for_pickup / delivered-but-not-yet-
 *   accepted). The legal basis for retaining the customer's identity
 *   while an order is being executed is Art. 6(1)(b) "processing
 *   necessary for the performance of a contract" — which supersedes
 *   Art. 17 erasure for as long as the contract is live. The user
 *   gets a 422 with the blocking order numbers and can either wait
 *   for fulfilment or contact support to cancel.
 *
 * Re-registration:
 *
 *   After deletion, the email is freed (the row's email was rewritten
 *   to the sentinel). A subsequent /auth/register POST with the
 *   original address succeeds — the register handler already filters
 *   the existing-email check by isNull(deletedAt).
 *
 * No CSRF token:
 *
 *   Same posture as PATCH /auth/me — SameSite=Lax on the cookie plus
 *   same-origin DELETE handles browser-initiated cross-site forgery.
 *   Re-auth via current password is the defence against compromised-
 *   session attempts.
 */

/** Order statuses that block account deletion (contract still in progress). */
const ACTIVE_ORDER_STATUSES = [
  "processing",
  "shipped",
  "ready_for_pickup",
  "delivered", // delivered-but-not-yet-accepted — customer still has the 14-day right
] as const;

/** Internal sentinel used in pseudonymised string columns. Short on purpose so
 * log greps for "[deleted]" find the trail easily. */
const PII_SENTINEL = "[deleted]";

export interface ActiveOrderBlock {
  /** Order numbers (YYYY-MM-NNNNN) currently blocking deletion. */
  orderNumbers: string[];
}

/**
 * Pre-flight check: are there any orders still in flight for this user?
 * Returns the list of blocking order numbers, or an empty array if the
 * user is clear to delete.
 */
export async function findActiveOrdersForUser(
  userId: string,
): Promise<ActiveOrderBlock> {
  const db = getDb();
  const rows = await db
    .select({ orderNumber: schema.orders.orderNumber })
    .from(schema.orders)
    .where(
      and(
        eq(schema.orders.customerId, userId),
        inArray(schema.orders.status, [...ACTIVE_ORDER_STATUSES]),
      ),
    )
    .orderBy(schema.orders.createdAt);
  return { orderNumbers: rows.map((r) => r.orderNumber) };
}

export interface DeleteAccountResult {
  /** The user's ORIGINAL email, captured before the row was pseudonymised.
   * The caller uses this to send the post-deletion notification. */
  originalEmail: string;
  /** The user's display name (if resolvable), captured pre-deletion for
   * the email greeting. */
  originalFullName: string | null;
  /** UTC instant the transaction committed. */
  deletedAt: Date;
}

/** Sentinel error subclasses so the route can map them to specific responses. */
export class AccountAlreadyDeletedError extends Error {
  constructor() {
    super("Account is already marked deleted.");
    this.name = "AccountAlreadyDeletedError";
  }
}

export class UserRowMissingError extends Error {
  constructor() {
    super("User row vanished between session validation and deletion.");
    this.name = "UserRowMissingError";
  }
}

/**
 * Execute the GDPR Art. 17 erasure transaction. The caller has already:
 *   - verified the session,
 *   - re-authed the current password,
 *   - confirmed there are no active orders.
 *
 * Order of operations matters: we collect the owned-orders set BEFORE
 * severing the customerId FK link, so we can target the dependent
 * side-tables (delivery_address, corporate_data, complaints) precisely
 * by orderId.
 *
 * Drops every session for the user as the final step (outside the
 * transaction, mirroring the password-reset flow's pattern — keeps the
 * DbClient union typing clean and avoids holding a row lock across a
 * sessions delete that could fan out across many rows).
 */
export async function executeAccountDeletion(input: {
  userId: string;
}): Promise<DeleteAccountResult> {
  const db = getDb();
  const sentinelEmail = `deleted-${randomUUID()}@deleted.invalid`;
  // Non-Argon2 sentinel. verifyPassword would reject it as a malformed hash
  // even before the deletedAt filter took effect — defence in depth.
  const sentinelPasswordHash = `deleted:${randomUUID()}`;
  const deletedAt = new Date();

  const result = await db.transaction(async (tx) => {
    // ── Capture original PII BEFORE we overwrite anything ────────────────
    const [user] = await tx
      .select({
        id: schema.users.id,
        email: schema.users.email,
        deletedAt: schema.users.deletedAt,
      })
      .from(schema.users)
      .where(eq(schema.users.id, input.userId))
      .limit(1);

    if (!user) throw new UserRowMissingError();
    if (user.deletedAt) throw new AccountAlreadyDeletedError();
    const originalEmail = user.email;

    // Resolve original display name (best effort — null is acceptable).
    let originalFullName: string | null = null;
    const [personal] = await tx
      .select({ fullName: schema.customerProfiles.fullName })
      .from(schema.customerProfiles)
      .where(eq(schema.customerProfiles.userId, input.userId))
      .limit(1);
    if (personal) {
      originalFullName = personal.fullName;
    } else {
      const [corp] = await tx
        .select({ contactName: schema.corporateProfiles.contactName })
        .from(schema.corporateProfiles)
        .where(eq(schema.corporateProfiles.userId, input.userId))
        .limit(1);
      if (corp) originalFullName = corp.contactName;
    }

    // Collect order IDs FIRST (before severing customerId).
    const ownedOrderRows = await tx
      .select({ id: schema.orders.id })
      .from(schema.orders)
      .where(eq(schema.orders.customerId, input.userId));
    const ownedOrderIds = ownedOrderRows.map((r) => r.id);

    // ── PSEUDONYMISE — legally-retained rows ────────────────────────────
    if (ownedOrderIds.length > 0) {
      await tx
        .update(schema.orderDeliveryAddress)
        .set({
          street: PII_SENTINEL,
          apartmentOrOffice: null,
        })
        .where(inArray(schema.orderDeliveryAddress.orderId, ownedOrderIds));

      await tx
        .update(schema.orderCorporateData)
        .set({
          contactName: PII_SENTINEL,
          // companyName, eik, vatNumber, registeredAddress, mol stay intact —
          // they ARE the invoice party under Bulgarian VAT law.
        })
        .where(inArray(schema.orderCorporateData.orderId, ownedOrderIds));

      await tx
        .update(schema.complaints)
        .set({
          customerEmail: PII_SENTINEL,
          customerName: PII_SENTINEL,
          customerPhone: PII_SENTINEL,
        })
        .where(inArray(schema.complaints.orderId, ownedOrderIds));

      // Sever the order_status_history actor link (this user as actor on
      // any order, theirs or someone else's — admin actions tracked here
      // would persist with NULL actor, which is what ON DELETE SET NULL
      // would do anyway).
      await tx
        .update(schema.orderStatusHistory)
        .set({ changedByUserId: null })
        .where(eq(schema.orderStatusHistory.changedByUserId, input.userId));

      // Now sever customerId + blank the denormalised order PII.
      await tx
        .update(schema.orders)
        .set({
          customerId: null,
          customerEmail: PII_SENTINEL,
          customerName: PII_SENTINEL,
          customerPhone: PII_SENTINEL,
        })
        .where(eq(schema.orders.customerId, input.userId));
    } else {
      // No owned orders — still sever any status-history actor entries
      // (this user may have been an admin acting on other people's orders;
      // unlikely for a customer, but harmless).
      await tx
        .update(schema.orderStatusHistory)
        .set({ changedByUserId: null })
        .where(eq(schema.orderStatusHistory.changedByUserId, input.userId));
    }

    // ── HARD-DELETE — non-retained personal data ────────────────────────
    // Order matters: cart_items cascades from carts.userId, so deleting
    // the cart row deletes the items too.
    await tx.delete(schema.carts).where(eq(schema.carts.userId, input.userId));

    await tx
      .delete(schema.addresses)
      .where(eq(schema.addresses.userId, input.userId));

    await tx
      .delete(schema.emailVerificationTokens)
      .where(eq(schema.emailVerificationTokens.userId, input.userId));
    await tx
      .delete(schema.passwordResetTokens)
      .where(eq(schema.passwordResetTokens.userId, input.userId));

    await tx
      .delete(schema.discounts)
      .where(eq(schema.discounts.userId, input.userId));

    await tx
      .delete(schema.mfaRecoveryCodes)
      .where(eq(schema.mfaRecoveryCodes.userId, input.userId));

    // login_attempts: keyed by email text, not user_id. Match by the
    // original email (before we rewrite it). The register/login layer
    // already normalises with .toLowerCase() via the EmailSchema, so the
    // stored values are already lower-cased.
    await tx
      .delete(schema.loginAttempts)
      .where(eq(schema.loginAttempts.email, originalEmail.toLowerCase()));

    await tx
      .delete(schema.customerProfiles)
      .where(eq(schema.customerProfiles.userId, input.userId));
    await tx
      .delete(schema.corporateProfiles)
      .where(eq(schema.corporateProfiles.userId, input.userId));

    // ── PSEUDONYMISE the users row itself ───────────────────────────────
    await tx
      .update(schema.users)
      .set({
        email: sentinelEmail,
        passwordHash: sentinelPasswordHash,
        emailVerifiedAt: null,
        failedLoginCount: 0,
        lockedUntil: null,
        mfaEnabled: false,
        mfaSecretEncrypted: null,
        deletedAt,
        anonymizedAt: deletedAt,
      })
      .where(eq(schema.users.id, input.userId));

    return { originalEmail, originalFullName, deletedAt };
  });

  // ── Drop all sessions ─────────────────────────────────────────────────
  // Outside the transaction. validateSession on any subsequent request
  // from any of this user's devices will refuse the session and clear
  // the orphaned cookie via the currentUser middleware (existing logic).
  await deleteAllSessionsForUser(input.userId);

  return result;
}

/**
 * Send the post-deletion notification. Best-effort — like every other
 * security-event email in this codebase, a SES outage MUST NOT roll back
 * the action that just completed.
 */
export interface SendAccountDeletedEmailInput {
  to: string;
  fullName?: string | null;
  deletedAt?: Date;
  logger?: Logger;
}

export async function sendAccountDeletedEmail(
  input: SendAccountDeletedEmailInput,
): Promise<{ ok: true; messageId: string } | { ok: false; error: unknown }> {
  const env = parseEnv();
  const supportEmail = extractAddress(env.EMAIL_FROM);
  const email = renderAccountDeletedEmail({
    to: input.to,
    fullName: input.fullName ?? null,
    deletedAt: input.deletedAt,
    ...(supportEmail !== null && { supportEmail }),
  });
  try {
    const result = await getEmailTransport().send(email);
    input.logger?.info(
      { templateId: email.templateId, messageId: result.messageId },
      "email_sent",
    );
    return { ok: true, messageId: result.messageId };
  } catch (err) {
    input.logger?.error({ err, templateId: email.templateId }, "email_send_failed");
    return { ok: false, error: err };
  }
}

/** Extract the bare RFC 5322 address from a "Name <addr>" pair. Mirrors the
 * helper inlined in password-reset.ts; kept private here to avoid an export
 * cycle. */
function extractAddress(addressOrPair: string): string | null {
  const angle = addressOrPair.match(/<([^>]+)>/);
  if (angle?.[1]) return angle[1].trim();
  const trimmed = addressOrPair.trim();
  if (trimmed.includes("@")) return trimmed;
  return null;
}
