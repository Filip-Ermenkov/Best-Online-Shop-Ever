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

// ─── Admin MFA primitives (TOTP, recovery codes, secret-at-rest, challenge) ──
// Pure crypto only — DB plumbing (lookups, replay-step persistence, lockout)
// lives in the API layer (@shop/api lib/admin-mfa.ts), keeping these reusable
// from shop-api, a future admin-api, and cron lambdas alike.

export {
  TOTP_DEFAULTS,
  generateTotpSecret,
  totpCode,
  totpCounter,
  verifyTotp,
  totpAuthUri,
  base32Encode,
  base32Decode,
  type TotpCodeOptions,
  type VerifyTotpOptions,
  type VerifyTotpResult,
  type TotpUriOptions,
} from "./totp.js";

export {
  loadMfaKey,
  generateMfaKeyBase64,
  encryptSecret,
  decryptSecret,
  keysEqual,
} from "./mfa-crypto.js";

export {
  RECOVERY_CODE_COUNT,
  generateRecoveryCodes,
  normalizeRecoveryCode,
  hashRecoveryCode,
  verifyRecoveryCode,
} from "./recovery-codes.js";

export {
  signChallenge,
  verifyChallenge,
  type ChallengePurpose,
  type ChallengePayload,
  type SignChallengeInput,
  type VerifyChallengeResult,
} from "./challenge.js";
