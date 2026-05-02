import { createHash, randomBytes } from "node:crypto";

/**
 * Session token plan, matching the OWASP Session Management Cheat Sheet
 * (current as of May 2026):
 *
 *   1. Generate 32 random bytes from a CSPRNG (256 bits of entropy — well
 *      above the OWASP-required 128 bit floor; 256 bits is also future-proof
 *      against birthday-bound concerns once the table grows past millions).
 *   2. Encode as base64url (no padding) so the token is URL- and cookie-safe
 *      without escaping. 32 bytes → 43 characters.
 *   3. Store ONLY the SHA-256 hash of the token in the DB. The plaintext
 *      lives exclusively in the user's cookie.
 *
 * Why SHA-256 and not Argon2id for the at-rest hash?
 *
 *   The rationale for slow hashing (argon2id) is to defang offline brute
 *   force when the input has low entropy — i.e. a human password. A 256-bit
 *   token from /dev/urandom has no such weakness: the search space is
 *   2^256, which is computationally unreachable regardless of hash speed.
 *   Slow hashing here would only hurt — every API request validates the
 *   session, and a 100 ms argon2id pass per request would push p99 latency
 *   past every reasonable budget.
 *
 *   This is the same conclusion Lucia v3 documented in its 2024 deprecation
 *   guide before turning into a learning resource. SHA-256 is the right
 *   choice for high-entropy session tokens.
 *
 * The DB column `sessions.id_hash` (text, primary key) is sized for the
 * 64-character hex SHA-256 output. A future tightening to SHA-3 would not
 * change the column shape.
 */

export const SESSION_TOKEN_BYTES = 32;

/**
 * Generate a fresh session token. Caller stores `hashSessionToken(token)`
 * in the DB and sets the plaintext in an HttpOnly cookie.
 *
 * The same token is unrecoverable once the response leaves the server —
 * if the user clears their cookie or we regenerate, the only path to
 * the original is the user's browser.
 */
export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
}

/**
 * Stable, deterministic hash of a session token for at-rest storage.
 * Use the SAME hash on lookup as on creation — `WHERE id_hash = ?`.
 *
 * Output: 64-character lowercase hex.
 */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
