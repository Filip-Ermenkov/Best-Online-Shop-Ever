import {
  renderAccountDeletionWarningEmail,
  renderPickupExpiredAdminEmail,
} from "@shop/email";
import type { Logger } from "pino";
import { getEmailTransport } from "./emails.js";
import { parseEnv } from "./env.js";
import { deriveSupportEmail } from "./withdrawal.js";

/**
 * Email sends fired by the scheduled jobs (src/jobs/*). Same posture as
 * lib/order-emails.ts and the withdrawal helpers:
 *
 *   - Wrap the transport call in try/catch; NEVER throw.
 *   - Return `boolean` so the job can compensate (un-claim its idempotency
 *     marker) when the transport refused the message — the next scheduled
 *     run then retries the send.
 *   - Logger is optional, used for warn-level failure logs only. Log lines
 *     carry ids + templateIds, never recipient addresses or body content.
 *
 * With EMAIL_TRANSPORT=sqs (the production target) `true` means durably
 * enqueued: the email-fn Lambda owns the actual SES delivery with retry +
 * DLQ, so a job never needs its own send-retry loop.
 */

export interface SendPickupExpiredAdminEmailInput {
  orderNumber: string;
  pickupDeadline: Date;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  logger?: Logger;
}

/**
 * Best-effort admin notification for an expired pickup deadline. The
 * recipient is the support inbox derived from EMAIL_FROM — the same
 * convention as the withdrawal admin notification.
 */
export async function sendPickupExpiredAdminEmail(
  input: SendPickupExpiredAdminEmailInput,
): Promise<boolean> {
  try {
    const env = parseEnv();
    const transport = getEmailTransport();
    const email = renderPickupExpiredAdminEmail({
      to: deriveSupportEmail(env.EMAIL_FROM),
      orderNumber: input.orderNumber,
      pickupDeadline: input.pickupDeadline,
      customerName: input.customerName,
      customerEmail: input.customerEmail,
      customerPhone: input.customerPhone,
      adminOrderUrl: `${env.PUBLIC_APP_BASE_URL}/admin/orders/${encodeURIComponent(input.orderNumber)}`,
    });
    await transport.send(email);
    return true;
  } catch (err) {
    input.logger?.warn(
      { err, orderNumber: input.orderNumber },
      "pickup_expired_admin_email_failed",
    );
    return false;
  }
}

export interface SendAccountDeletionWarningEmailInput {
  to: string;
  fullName: string | null;
  /** Plaintext of the freshly issued signup-verification token. */
  token: string;
  /** Registration + 7 days — when the account becomes eligible for deletion. */
  deleteAfter: Date;
  logger?: Logger;
}

/**
 * Best-effort day-6 deletion warning for an unverified account. The verify
 * link embeds a FRESH token issued by the cleanup job (the registration
 * token has long expired); the resend path points at the storefront, where
 * the signed-in unverified user gets the resend banner.
 */
export async function sendAccountDeletionWarningEmail(
  input: SendAccountDeletionWarningEmailInput,
): Promise<boolean> {
  try {
    const env = parseEnv();
    const transport = getEmailTransport();
    const email = renderAccountDeletionWarningEmail({
      to: input.to,
      fullName: input.fullName,
      verifyUrl: `${env.PUBLIC_APP_BASE_URL}/account/verify-email?token=${encodeURIComponent(input.token)}`,
      resendUrl: env.PUBLIC_APP_BASE_URL,
      deleteAfter: input.deleteAfter,
    });
    await transport.send(email);
    return true;
  } catch (err) {
    // Field NAMES only — the recipient address is PII and stays out of logs.
    input.logger?.warn({ err }, "account_deletion_warning_email_failed");
    return false;
  }
}
