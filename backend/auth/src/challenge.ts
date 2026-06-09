import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Short-lived, signed challenge tokens for multi-step authentication.
 *
 * Admin login is two-factor and two-step: the password is verified first, then
 * the TOTP code. Between those steps the server must remember "this person
 * proved the password factor for account X" WITHOUT issuing a real session
 * (issuing a session before the second factor would defeat MFA). This is that
 * intermediate credential.
 *
 * It is a stateless HMAC-signed token rather than a DB row: it carries no
 * authority of its own — it only grants the right to ATTEMPT the second factor,
 * which is itself verified — so it needs no server-side storage or revocation.
 * Short TTL (minutes) bounds the window. This mirrors the project's existing
 * "high-entropy secret, verified server-side" posture without adding a JWT
 * dependency or a new table.
 *
 * Format:  base64url(JSON payload) "." base64url(HMAC-SHA256(payload, key))
 * Payload: { u: userId, p: purpose, exp: epochSeconds }
 *
 * Purposes are distinct so a token minted for one step can't be replayed into
 * another (e.g. an enrolment token can't satisfy a login challenge).
 */

export type ChallengePurpose = "admin_mfa" | "admin_mfa_enroll";

export interface ChallengePayload {
  userId: string;
  purpose: ChallengePurpose;
  /** Expiry, epoch seconds. */
  exp: number;
}

export interface SignChallengeInput {
  userId: string;
  purpose: ChallengePurpose;
  ttlSeconds: number;
  /** Injectable clock for tests. */
  nowMs?: number;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sign(payloadB64: string, key: string): string {
  return b64url(createHmac("sha256", key).update(payloadB64).digest());
}

/** Mint a signed challenge token. */
export function signChallenge(input: SignChallengeInput, key: string): string {
  if (!key) throw new Error("Challenge signing key is not configured");
  const now = input.nowMs ?? Date.now();
  const payload: ChallengePayload = {
    userId: input.userId,
    purpose: input.purpose,
    exp: Math.floor(now / 1000) + input.ttlSeconds,
  };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${payloadB64}.${sign(payloadB64, key)}`;
}

export type VerifyChallengeResult =
  | { valid: true; userId: string }
  | { valid: false };

/**
 * Verify a challenge token: signature (constant-time), expiry, and that the
 * declared purpose matches what the caller expects. Any failure → { valid:
 * false } with no distinguishing detail (no oracle for attackers).
 */
export function verifyChallenge(
  token: string,
  expectedPurpose: ChallengePurpose,
  key: string,
  nowMs: number = Date.now(),
): VerifyChallengeResult {
  if (!key || typeof token !== "string") return { valid: false };
  const dot = token.indexOf(".");
  if (dot <= 0) return { valid: false };

  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  // Constant-time signature check on equal-length buffers.
  const expectedSig = Buffer.from(sign(payloadB64, key), "utf8");
  const gotSig = Buffer.from(sigB64, "utf8");
  if (
    expectedSig.length !== gotSig.length ||
    !timingSafeEqual(expectedSig, gotSig)
  ) {
    return { valid: false };
  }

  let payload: ChallengePayload;
  try {
    payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8"),
    ) as ChallengePayload;
  } catch {
    return { valid: false };
  }

  if (
    !payload ||
    typeof payload.userId !== "string" ||
    payload.purpose !== expectedPurpose ||
    typeof payload.exp !== "number"
  ) {
    return { valid: false };
  }
  if (Math.floor(nowMs / 1000) >= payload.exp) {
    return { valid: false }; // expired
  }
  return { valid: true, userId: payload.userId };
}
