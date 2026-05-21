/**
 * @shop/auth — auth crypto primitives.
 *
 * Pure functions only. No DB, no HTTP. Anything stateful (session lookup,
 * lockout counters, login_attempts inserts) lives in the API layer. That keeps
 * this package equally usable from shop-api, admin-api, and any cron lambdas.
 *
 *   import { hashPassword, verifyPassword } from "@shop/auth";
 *   import { generateSessionToken, hashSessionToken } from "@shop/auth";
 */

export {
  hashPassword,
  verifyPassword,
  needsRehash,
  PASSWORD_HASH_OPTIONS,
  DUMMY_PASSWORD_HASH,
} from "./password.js";

export {
  generateSessionToken,
  hashSessionToken,
  SESSION_TOKEN_BYTES,
} from "./session-tokens.js";

export {
  checkPasswordBreached,
  BREACHED_PASSWORD_CONSTANTS,
  type BreachedPasswordCheck,
  type BreachedPasswordOptions,
} from "./breached-password.js";
