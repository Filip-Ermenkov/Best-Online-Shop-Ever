import { randomInt } from "node:crypto";
import { hashPassword, verifyPassword } from "./password.js";

/**
 * Single-use MFA recovery codes — the account-recovery path for an admin who
 * loses their TOTP device. Both NIST SP 800-63B-4 (look-up secrets) and the
 * OWASP MFA Cheat Sheet call for exactly this: a set of CSPRNG-generated,
 * single-use secrets handed to the subscriber when MFA is enrolled, each usable
 * once. They populate the `mfa_recovery_codes` table, which is schema-commented
 * "Hashed at rest (Argon2id) — even with DB access, codes cannot be enumerated."
 *
 * Design choices:
 *   - 10 codes per set (industry norm: GitHub, Google, AWS all issue ~10).
 *   - Each code is 10 characters from a 29-symbol unambiguous alphabet
 *     (Crockford-style: no 0/O/1/I/L/U), i.e. ~48 bits of entropy — far above
 *     the NIST look-up-secret floor of ~20 bits and infeasible to guess even
 *     before rate-limiting. Formatted XXXXX-XXXXX for legibility.
 *   - Hashed with the same Argon2id primitive as passwords. A recovery code's
 *     entropy already defeats offline brute force; Argon2id is belt-and-braces
 *     and keeps one hashing path in the codebase.
 *   - Verification is normalised (case-insensitive, separators ignored) so a
 *     user re-typing "abcde-fghjk" or "ABCDEFGHJK" both work.
 */

export const RECOVERY_CODE_COUNT = 10;
const CODE_LENGTH = 10; // characters, excluding the separator
const GROUP = 5; // dash every 5 chars → XXXXX-XXXXX

// Crockford-inspired alphabet minus the visually ambiguous glyphs (0/O, 1/I/L,
// U). 29 symbols → ~4.86 bits per character.
const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

/**
 * Generate a fresh set of plaintext recovery codes. These are returned to the
 * subscriber exactly once (at enrolment / regeneration) and never stored in
 * plaintext — the caller hashes them via `hashRecoveryCode` before persisting.
 */
export function generateRecoveryCodes(
  count: number = RECOVERY_CODE_COUNT,
): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    let raw = "";
    for (let j = 0; j < CODE_LENGTH; j++) {
      // randomInt is rejection-sampled by Node — no modulo bias.
      raw += ALPHABET[randomInt(ALPHABET.length)];
    }
    codes.push(`${raw.slice(0, GROUP)}-${raw.slice(GROUP)}`);
  }
  return codes;
}

/**
 * Normalise a code for hashing/verification: strip separators and whitespace,
 * uppercase. Makes "abcde-fghjk", "ABCDE FGHJK", and "ABCDEFGHJK" equivalent.
 */
export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
}

/** Argon2id hash of a recovery code, normalised first. Store this. */
export function hashRecoveryCode(code: string): Promise<string> {
  return hashPassword(normalizeRecoveryCode(code));
}

/** Constant-time (Argon2id) verify of a candidate code against a stored hash. */
export function verifyRecoveryCode(hash: string, code: string): Promise<boolean> {
  return verifyPassword(hash, normalizeRecoveryCode(code));
}
