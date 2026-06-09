import { describe, expect, it } from "vitest";
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
  RECOVERY_CODE_COUNT,
  verifyRecoveryCode,
} from "../src/recovery-codes.js";

describe("generateRecoveryCodes", () => {
  it("generates 10 codes by default", () => {
    expect(generateRecoveryCodes()).toHaveLength(RECOVERY_CODE_COUNT);
  });

  it("formats each code as XXXXX-XXXXX from the unambiguous alphabet", () => {
    for (const code of generateRecoveryCodes()) {
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    }
  });

  it("excludes visually ambiguous glyphs (0/O, 1/I/L, U)", () => {
    const joined = generateRecoveryCodes(50).join("");
    expect(joined).not.toMatch(/[OILU01]/);
  });

  it("produces unique codes (CSPRNG)", () => {
    const codes = generateRecoveryCodes(50);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("normalizeRecoveryCode", () => {
  it("strips separators/whitespace and uppercases", () => {
    expect(normalizeRecoveryCode("abcde-fghjk")).toBe("ABCDEFGHJK");
    expect(normalizeRecoveryCode("ABCDE FGHJK")).toBe("ABCDEFGHJK");
  });
});

describe("hashRecoveryCode / verifyRecoveryCode", () => {
  it("verifies a correct code regardless of formatting", async () => {
    const [code] = generateRecoveryCodes(1);
    const hash = await hashRecoveryCode(code!);
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyRecoveryCode(hash, code!)).toBe(true);
    // Same code, different formatting still verifies.
    expect(await verifyRecoveryCode(hash, code!.replace("-", "").toLowerCase())).toBe(
      true,
    );
  });

  it("rejects an incorrect code", async () => {
    const [a, b] = generateRecoveryCodes(2);
    const hash = await hashRecoveryCode(a!);
    expect(await verifyRecoveryCode(hash, b!)).toBe(false);
  });

  it("returns false (never throws) on a malformed hash", async () => {
    expect(await verifyRecoveryCode("not-a-hash", "ABCDE-FGHJK")).toBe(false);
  });
});
