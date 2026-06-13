/**
 * @shop/email — transactional email.
 *
 * Pure transports + templates. Token generation, DB writes and the
 * surrounding HTTP flow all live in shop-api. This package knows nothing
 * about users, sessions, or the database — that keeps it equally usable
 * from shop-api, admin-api and any cron Lambda that needs to send mail
 * (e.g. order-status updates).
 *
 *   import {
 *     createConsoleTransport,
 *     createSesTransport,
 *     createStubTransport,
 *     renderVerificationEmail,
 *   } from "@shop/email";
 */

export type {
  EmailTransport,
  OutgoingEmail,
  SendResult,
} from "./types.js";

export { createConsoleTransport } from "./transports/console.js";
export { createSesTransport } from "./transports/ses.js";
export type { SesTransportOptions } from "./transports/ses.js";
export { createSqsTransport } from "./transports/sqs.js";
export type { SqsTransportOptions } from "./transports/sqs.js";
export {
  createStubTransport,
} from "./transports/stub.js";
export type { StubEmailTransport } from "./transports/stub.js";

// Queue contract + consumer (the email-fn Lambda entry itself is
// src/queue/handler.ts, bundled by build.mjs — deliberately not exported).
export {
  EMAIL_QUEUE_ENVELOPE_VERSION,
  MAX_ENVELOPE_BYTES,
  EmailEnvelopeError,
  encodeEmailQueueEnvelope,
  decodeEmailQueueEnvelope,
} from "./queue/envelope.js";
export type { EmailQueueEnvelope } from "./queue/envelope.js";
export { createEmailQueueConsumer } from "./queue/consumer.js";
export type {
  EmailQueueConsumerOptions,
  EmailQueueEvent,
  EmailQueueRecord,
  EmailQueueBatchResponse,
  EmailQueueLogger,
} from "./queue/consumer.js";

export {
  renderVerificationEmail,
  VERIFICATION_TEMPLATE_ID,
} from "./templates/verification.js";
export type { VerificationTemplateInput } from "./templates/verification.js";

export {
  renderPasswordResetEmail,
  PASSWORD_RESET_TEMPLATE_ID,
} from "./templates/password-reset.js";
export type { PasswordResetTemplateInput } from "./templates/password-reset.js";

export {
  renderPasswordChangedEmail,
  PASSWORD_CHANGED_TEMPLATE_ID,
} from "./templates/password-changed.js";
export type { PasswordChangedTemplateInput } from "./templates/password-changed.js";

export {
  renderEmailChangeVerifyEmail,
  EMAIL_CHANGE_VERIFY_TEMPLATE_ID,
} from "./templates/email-change-verify.js";
export type { EmailChangeVerifyTemplateInput } from "./templates/email-change-verify.js";

export {
  renderEmailChangeAlertEmail,
  EMAIL_CHANGE_ALERT_TEMPLATE_ID,
} from "./templates/email-change-alert.js";
export type { EmailChangeAlertTemplateInput } from "./templates/email-change-alert.js";

export {
  renderEmailChangedEmail,
  EMAIL_CHANGED_TEMPLATE_ID,
} from "./templates/email-changed.js";
export type { EmailChangedTemplateInput } from "./templates/email-changed.js";

export {
  renderWithdrawalReceivedEmail,
  WITHDRAWAL_RECEIVED_TEMPLATE_ID,
} from "./templates/withdrawal-received.js";
export type { WithdrawalReceivedTemplateInput } from "./templates/withdrawal-received.js";

export {
  renderWithdrawalAdminNotificationEmail,
  WITHDRAWAL_ADMIN_NOTIFICATION_TEMPLATE_ID,
} from "./templates/withdrawal-admin-notification.js";
export type { WithdrawalAdminNotificationTemplateInput } from "./templates/withdrawal-admin-notification.js";

export {
  renderAccountDeletedEmail,
  ACCOUNT_DELETED_TEMPLATE_ID,
} from "./templates/account-deleted.js";
export type { AccountDeletedTemplateInput } from "./templates/account-deleted.js";

export {
  renderOrderConfirmationEmail,
  ORDER_CONFIRMATION_TEMPLATE_ID,
} from "./templates/order-confirmation.js";
export type {
  OrderConfirmationTemplateInput,
  OrderConfirmationLineItem,
  OrderConfirmationDeliveryAddress,
  OrderConfirmationPaymentMethod,
} from "./templates/order-confirmation.js";

export {
  renderOrderStatusUpdateEmail,
  ORDER_STATUS_UPDATE_TEMPLATE_ID,
} from "./templates/order-status-update.js";
export type {
  OrderStatusUpdateTemplateInput,
  OrderStatusUpdateStatus,
} from "./templates/order-status-update.js";

export {
  renderDataExportedEmail,
  DATA_EXPORTED_TEMPLATE_ID,
} from "./templates/data-exported.js";
export type { DataExportedTemplateInput } from "./templates/data-exported.js";

export {
  renderPickupExpiredAdminEmail,
  PICKUP_EXPIRED_ADMIN_TEMPLATE_ID,
} from "./templates/pickup-expired-admin.js";
export type { PickupExpiredAdminTemplateInput } from "./templates/pickup-expired-admin.js";

export {
  renderAccountDeletionWarningEmail,
  ACCOUNT_DELETION_WARNING_TEMPLATE_ID,
} from "./templates/account-deletion-warning.js";
export type { AccountDeletionWarningTemplateInput } from "./templates/account-deletion-warning.js";
