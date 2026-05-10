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
