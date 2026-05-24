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
export {
  createStubTransport,
} from "./transports/stub.js";
export type { StubEmailTransport } from "./transports/stub.js";

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
