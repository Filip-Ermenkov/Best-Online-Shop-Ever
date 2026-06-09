import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * RFC 6238 Time-based One-Time Passwords (TOTP), built on RFC 4226 HOTP.
 *
 * Pure functions, Node-builtin crypto only — no third-party OTP library. TOTP
 * is a small, fully-specified algorithm; a vetted from-scratch implementation
 * keeps the dependency surface (and SBOM) minimal and is verified against the
 * official RFC 6238 Appendix B test vectors in tests/totp.test.ts. That is a
 * stronger correctness guarantee than trusting an unpinned transitive dep.
 *
 * Algorithm parameters are the de-facto interoperable defaults that every
 * mainstream authenticator app (Google Authenticator, Authy, 1Password, Aegis,
 * Microsoft Authenticator) assumes when it scans a bare otpauth:// URI:
 *
 *   - HMAC-SHA1            (RFC 6238 §1.2 default; SHA256/512 exist but are not
 *                           universally supported by authenticator apps in 2026)
 *   - 6 digits             (RFC 4226 §5.3 default)
 *   - 30-second time step  (RFC 6238 §4 recommended default)
 *   - T0 = 0 (Unix epoch)  (RFC 6238 §4.1)
 *
 * Security properties enforced here and by the callers:
 *   - Secret is ≥160 bits from a CSPRNG (RFC 4226 §4 R6; OWASP MFA Cheat Sheet).
 *   - Verification accepts a small ±N-step skew window for clock drift
 *     (default ±1 = the current step plus one before/after; RFC 6238 §5.2).
 *   - Replay/code-reuse is prevented by the caller passing `afterStep` — the
 *     last successfully-consumed counter — so a code can be redeemed at most
 *     once even inside its validity window (Authgear "5 common TOTP mistakes",
 *     2026; the top real-world TOTP defect). See @shop/api admin-mfa.ts.
 *   - All code comparison is constant-time (timingSafeEqual).
 */

export const TOTP_DEFAULTS = {
  /** Secret size in bytes. 20 bytes = 160 bits — the RFC 4226 floor and the
   *  size used by the RFC 6238 SHA1 reference vectors. */
  secretBytes: 20,
  digits: 6,
  /** Time step in seconds. */
  periodSeconds: 30,
  algorithm: "SHA1" as const,
  /** Steps of skew tolerated on each side of the current step. */
  window: 1,
} as const;

// ─── Base32 (RFC 4648, no padding) ──────────────────────────────────────────
//
// Authenticator apps exchange the shared secret as Base32 (the otpauth:// URI
// `secret=` parameter). We encode/decode with the standard RFC 4648 alphabet,
// uppercase, padding stripped — the form Google Authenticator and friends emit
// and accept.

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Encode bytes to an unpadded, uppercase RFC 4648 Base32 string. */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

/**
 * Decode an RFC 4648 Base32 string back to bytes. Tolerant of lowercase,
 * spaces, and `=` padding (authenticator apps and humans paste secrets in all
 * of these forms). Throws on any character outside the alphabet.
 */
export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/g, "").replace(/\s+/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) {
      throw new Error("Invalid Base32 character in TOTP secret");
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * Generate a fresh TOTP secret. Returns the Base32 string to hand to the
 * authenticator app (via the otpauth URI / QR) — the caller is responsible for
 * encrypting it at rest (see @shop/auth mfa-crypto.ts); the plaintext Base32
 * must never be stored.
 */
export function generateTotpSecret(
  bytes: number = TOTP_DEFAULTS.secretBytes,
): string {
  return base32Encode(randomBytes(bytes));
}

// ─── HOTP / TOTP core ───────────────────────────────────────────────────────

/** RFC 4226 HOTP: HMAC-SHA1 of an 8-byte big-endian counter, dynamically
 *  truncated to `digits` decimal digits. */
function hotp(key: Buffer, counter: number, digits: number): string {
  const counterBuf = Buffer.alloc(8);
  // 64-bit counter. JS bitwise ops are 32-bit, so write as two 32-bit halves.
  // TOTP counters won't exceed 2^53 for millennia, so the high word is the
  // safe-integer high bits.
  counterBuf.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0);
  counterBuf.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac("sha1", key).update(counterBuf).digest();
  // Dynamic truncation (RFC 4226 §5.3): low 4 bits of the last byte select the
  // offset; read 4 bytes there, mask the sign bit, mod 10^digits.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  const code = binary % 10 ** digits;
  return code.toString().padStart(digits, "0");
}

/** The TOTP counter (time-step index) for a given epoch-ms instant. */
export function totpCounter(
  timeMs: number = Date.now(),
  periodSeconds: number = TOTP_DEFAULTS.periodSeconds,
): number {
  return Math.floor(timeMs / 1000 / periodSeconds);
}

export interface TotpCodeOptions {
  timeMs?: number;
  digits?: number;
  periodSeconds?: number;
}

/** Compute the current TOTP code for a Base32 secret. */
export function totpCode(
  secretBase32: string,
  opts: TotpCodeOptions = {},
): string {
  const digits = opts.digits ?? TOTP_DEFAULTS.digits;
  const period = opts.periodSeconds ?? TOTP_DEFAULTS.periodSeconds;
  const counter = totpCounter(opts.timeMs ?? Date.now(), period);
  return hotp(base32Decode(secretBase32), counter, digits);
}

export interface VerifyTotpOptions extends TotpCodeOptions {
  /** Steps of clock-skew tolerance on each side of the current step. */
  window?: number;
  /**
   * Replay guard. If provided, only a counter STRICTLY GREATER than this is
   * accepted — the last consumed step. Pass the value persisted from the
   * previous successful verification to make every code single-use even
   * within its skew window.
   */
  afterStep?: number | null;
}

export interface VerifyTotpResult {
  valid: boolean;
  /** The counter (time step) the code matched at. Persist it as the next
   *  `afterStep` to block replay. Undefined when `valid` is false. */
  step?: number;
}

/**
 * Verify a user-supplied TOTP code against a Base32 secret, scanning the skew
 * window and (optionally) enforcing the monotonic replay guard.
 *
 * Returns the matched step so the caller can persist it. The scan runs newest
 * step first so a normal (non-replayed) code matches on the first comparison.
 */
export function verifyTotp(
  secretBase32: string,
  token: string,
  opts: VerifyTotpOptions = {},
): VerifyTotpResult {
  const digits = opts.digits ?? TOTP_DEFAULTS.digits;
  const period = opts.periodSeconds ?? TOTP_DEFAULTS.periodSeconds;
  const window = opts.window ?? TOTP_DEFAULTS.window;
  const afterStep = opts.afterStep ?? null;

  const candidate = (token ?? "").replace(/\s+/g, "");
  // Length/shape gate before any HMAC work. A non-numeric or wrong-length input
  // can never match; rejecting early also keeps timingSafeEqual operands equal-
  // length below.
  if (candidate.length !== digits || !/^\d+$/.test(candidate)) {
    return { valid: false };
  }

  const key = base32Decode(secretBase32);
  const current = totpCounter(opts.timeMs ?? Date.now(), period);

  for (let offset = window; offset >= -window; offset--) {
    const counter = current + offset;
    if (counter < 0) continue;
    if (afterStep !== null && counter <= afterStep) continue; // replay guard
    const expected = hotp(key, counter, digits);
    if (constantTimeEquals(expected, candidate)) {
      return { valid: true, step: counter };
    }
  }
  return { valid: false };
}

/** Constant-time string compare. Returns false for length mismatch without
 *  leaking via early-out (length is not a secret here, but keep it uniform). */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ─── otpauth:// provisioning URI ────────────────────────────────────────────

export interface TotpUriOptions {
  secretBase32: string;
  /** The account the credential belongs to, e.g. the admin email. */
  accountName: string;
  /** The issuer label shown in the authenticator app, e.g. "Best Online Shop". */
  issuer: string;
  digits?: number;
  periodSeconds?: number;
}

/**
 * Build the otpauth://totp/ provisioning URI an authenticator app consumes
 * (rendered as a QR code by the frontend, or pasted manually). Follows the
 * Key Uri Format the ecosystem standardised around
 * (github.com/google/google-authenticator/wiki/Key-Uri-Format):
 *
 *   otpauth://totp/Issuer:account?secret=…&issuer=Issuer&algorithm=SHA1
 *            &digits=6&period=30
 *
 * The issuer appears BOTH in the label prefix and the `issuer` parameter — the
 * redundancy is intentional and recommended for maximum app compatibility.
 */
export function totpAuthUri(opts: TotpUriOptions): string {
  const digits = opts.digits ?? TOTP_DEFAULTS.digits;
  const period = opts.periodSeconds ?? TOTP_DEFAULTS.periodSeconds;
  const label = `${encodeURIComponent(opts.issuer)}:${encodeURIComponent(
    opts.accountName,
  )}`;
  const params = new URLSearchParams({
    secret: opts.secretBase32,
    issuer: opts.issuer,
    algorithm: TOTP_DEFAULTS.algorithm,
    digits: String(digits),
    period: String(period),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
