import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  totpAuthUri,
  totpCode,
  totpCounter,
  verifyTotp,
} from "../src/totp.js";

/**
 * The authoritative correctness check: RFC 6238 Appendix B reference vectors.
 * If totpCode reproduces these byte-for-byte, the HOTP dynamic-truncation, the
 * counter derivation, and the Base32 path are all correct.
 *
 * RFC 6238 Appendix B uses the ASCII seed "12345678901234567890" (20 bytes) for
 * the SHA-1 variant and prints 8-digit codes. We feed the same seed (Base32-
 * encoded) and assert digits: 8.
 */
const RFC6238_SEED_ASCII = "12345678901234567890";
const RFC6238_SECRET_B32 = base32Encode(Buffer.from(RFC6238_SEED_ASCII, "ascii"));

const RFC6238_VECTORS: Array<{ timeSec: number; code: string }> = [
  { timeSec: 59, code: "94287082" },
  { timeSec: 1111111109, code: "07081804" },
  { timeSec: 1111111111, code: "14050471" },
  { timeSec: 1234567890, code: "89005924" },
  { timeSec: 2000000000, code: "69279037" },
  { timeSec: 20000000000, code: "65353130" },
];

describe("Base32 (RFC 4648)", () => {
  it("encodes the RFC 6238 seed to the canonical Base32 string", () => {
    // Known-answer: "12345678901234567890" → GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
    expect(RFC6238_SECRET_B32).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });

  it("round-trips arbitrary bytes", () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 255, 128, 7]);
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
  });

  it("tolerates lowercase, spaces and padding on decode", () => {
    const canonical = base32Decode("GEZDGNBVGY3TQOJQ");
    expect(base32Decode("gezdgnbv gy3tqojq").equals(canonical)).toBe(true);
    expect(base32Decode("GEZDGNBVGY3TQOJQ====").equals(canonical)).toBe(true);
  });

  it("throws on a character outside the alphabet", () => {
    expect(() => base32Decode("0189!")).toThrow(/Invalid Base32/);
  });
});

describe("totpCode — RFC 6238 Appendix B vectors (SHA-1, 8 digits)", () => {
  for (const { timeSec, code } of RFC6238_VECTORS) {
    it(`T=${timeSec} → ${code}`, () => {
      expect(
        totpCode(RFC6238_SECRET_B32, { timeMs: timeSec * 1000, digits: 8 }),
      ).toBe(code);
    });
  }

  it("derives the 6-digit code as the low 6 digits of the 8-digit code", () => {
    // T=59 → 8-digit 94287082, so the 6-digit code is 287082.
    expect(totpCode(RFC6238_SECRET_B32, { timeMs: 59 * 1000, digits: 6 })).toBe(
      "287082",
    );
  });
});

describe("totpCounter", () => {
  it("advances once per 30-second period from the Unix epoch", () => {
    expect(totpCounter(0)).toBe(0);
    expect(totpCounter(29_999)).toBe(0);
    expect(totpCounter(30_000)).toBe(1);
    expect(totpCounter(59_999)).toBe(1);
    expect(totpCounter(60_000)).toBe(2);
  });
});

describe("generateTotpSecret", () => {
  it("returns a 160-bit secret as 32 Base32 chars by default", () => {
    const secret = generateTotpSecret();
    // 20 bytes → 32 Base32 characters (no padding).
    expect(secret).toHaveLength(32);
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(base32Decode(secret)).toHaveLength(20);
  });

  it("is different on each call (CSPRNG)", () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a).not.toBe(b);
  });
});

describe("verifyTotp", () => {
  const secret = generateTotpSecret();
  // Pin a fixed instant well clear of a period boundary so ±1-step tests are
  // deterministic.
  const now = 1_700_000_015_000; // 2023-11-14T22:13:35Z (step boundary +15s)

  it("accepts the current code and reports the matched step", () => {
    const code = totpCode(secret, { timeMs: now });
    const res = verifyTotp(secret, code, { timeMs: now });
    expect(res.valid).toBe(true);
    expect(res.step).toBe(totpCounter(now));
  });

  it("accepts a code one step early/late (clock-skew window ±1)", () => {
    const prev = totpCode(secret, { timeMs: now - 30_000 });
    const next = totpCode(secret, { timeMs: now + 30_000 });
    expect(verifyTotp(secret, prev, { timeMs: now }).valid).toBe(true);
    expect(verifyTotp(secret, next, { timeMs: now }).valid).toBe(true);
  });

  it("rejects a code two steps away (outside the default window)", () => {
    const old = totpCode(secret, { timeMs: now - 60_000 });
    expect(verifyTotp(secret, old, { timeMs: now }).valid).toBe(false);
  });

  it("rejects wrong-length, non-numeric and empty input without throwing", () => {
    expect(verifyTotp(secret, "", { timeMs: now }).valid).toBe(false);
    expect(verifyTotp(secret, "12345", { timeMs: now }).valid).toBe(false);
    expect(verifyTotp(secret, "abcdef", { timeMs: now }).valid).toBe(false);
  });

  it("enforces the replay guard: a code at step ≤ afterStep is rejected", () => {
    const code = totpCode(secret, { timeMs: now });
    const step = totpCounter(now);
    // First use succeeds and yields `step`.
    expect(verifyTotp(secret, code, { timeMs: now }).valid).toBe(true);
    // Replaying the same code once `afterStep = step` is recorded is rejected,
    // even though it is still within its 30s validity window.
    expect(
      verifyTotp(secret, code, { timeMs: now, afterStep: step }).valid,
    ).toBe(false);
  });

  it("still accepts a fresh future code after the replay guard is set", () => {
    const step = totpCounter(now);
    const future = now + 60_000;
    const code = totpCode(secret, { timeMs: future });
    const res = verifyTotp(secret, code, { timeMs: future, afterStep: step });
    expect(res.valid).toBe(true);
    expect(res.step!).toBeGreaterThan(step);
  });
});

describe("totpAuthUri", () => {
  it("builds a spec-compliant otpauth:// URI", () => {
    const uri = totpAuthUri({
      secretBase32: "GEZDGNBVGY3TQOJQ",
      accountName: "admin@shop.bg",
      issuer: "Best Online Shop",
    });
    expect(uri.startsWith("otpauth://totp/")).toBe(true);
    // Issuer appears in both the label prefix and the issuer param.
    expect(uri).toContain("Best%20Online%20Shop:admin%40shop.bg");
    expect(uri).toContain("secret=GEZDGNBVGY3TQOJQ");
    expect(uri).toContain("issuer=Best+Online+Shop");
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});
