import { describe, expect, it } from "vitest";
import { signChallenge, verifyChallenge } from "../src/challenge.js";

const KEY = "test-challenge-signing-key-please-rotate";

describe("signChallenge / verifyChallenge", () => {
  it("round-trips a valid challenge and returns the userId", () => {
    const token = signChallenge(
      { userId: "user-123", purpose: "admin_mfa", ttlSeconds: 300 },
      KEY,
    );
    const res = verifyChallenge(token, "admin_mfa", KEY);
    expect(res).toEqual({ valid: true, userId: "user-123" });
  });

  it("rejects a token signed with a different key", () => {
    const token = signChallenge(
      { userId: "u", purpose: "admin_mfa", ttlSeconds: 300 },
      KEY,
    );
    expect(verifyChallenge(token, "admin_mfa", "other-key").valid).toBe(false);
  });

  it("rejects a purpose mismatch (enrol token can't satisfy a login challenge)", () => {
    const token = signChallenge(
      { userId: "u", purpose: "admin_mfa_enroll", ttlSeconds: 300 },
      KEY,
    );
    expect(verifyChallenge(token, "admin_mfa", KEY).valid).toBe(false);
  });

  it("rejects an expired token", () => {
    const t0 = 1_700_000_000_000;
    const token = signChallenge(
      { userId: "u", purpose: "admin_mfa", ttlSeconds: 300, nowMs: t0 },
      KEY,
    );
    // 301 seconds later → expired.
    expect(verifyChallenge(token, "admin_mfa", KEY, t0 + 301_000).valid).toBe(
      false,
    );
    // 299 seconds later → still valid.
    expect(verifyChallenge(token, "admin_mfa", KEY, t0 + 299_000).valid).toBe(
      true,
    );
  });

  it("rejects a tampered payload", () => {
    const token = signChallenge(
      { userId: "u", purpose: "admin_mfa", ttlSeconds: 300 },
      KEY,
    );
    const [, sig] = token.split(".");
    const forged = `${Buffer.from(
      JSON.stringify({ userId: "attacker", purpose: "admin_mfa", exp: 9_999_999_999 }),
    ).toString("base64url")}.${sig}`;
    expect(verifyChallenge(forged, "admin_mfa", KEY).valid).toBe(false);
  });

  it("rejects malformed tokens without throwing", () => {
    expect(verifyChallenge("", "admin_mfa", KEY).valid).toBe(false);
    expect(verifyChallenge("noseparator", "admin_mfa", KEY).valid).toBe(false);
    expect(verifyChallenge(".onlysig", "admin_mfa", KEY).valid).toBe(false);
  });
});
