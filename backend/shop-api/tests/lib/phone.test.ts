import { describe, expect, it } from "vitest";
import { normalizeBulgarianPhone } from "../../src/lib/phone.js";

/**
 * Pure-function unit tests for the Bulgarian phone normaliser. No DB, no
 * HTTP, no fixture — covers the canonicalisation contract documented in
 * `src/lib/phone.ts`.
 *
 * The contract is:
 *   - Accept E.164 (+359...), international long-distance (00359...), or
 *     national-with-trunk-prefix (0...) input forms.
 *   - Strip whitespace, dashes, dots, parentheses.
 *   - Require national-significant number in `^[2-9]\d{6,8}$`.
 *   - Output canonical E.164 `+359` + national digits, OR null on rejection.
 */
describe("normalizeBulgarianPhone", () => {
  describe("accepted inputs", () => {
    it.each([
      // Each row: [input, expected canonical E.164].
      ["+359888123456", "+359888123456"],
      ["+359 888 123 456", "+359888123456"],
      ["+359-888-123-456", "+359888123456"],
      ["+359 (888) 123.456", "+359888123456"],
      // International long-distance prefix.
      ["00359888123456", "+359888123456"],
      ["00 359 888 123 456", "+359888123456"],
      // National with trunk prefix (0).
      ["0888123456", "+359888123456"],
      ["0888 123 456", "+359888123456"],
      ["088-812-34-56", "+359888123456"],
      // Mobile prefixes 87, 88, 89 — all currently allocated to BG carriers.
      ["0879123456", "+359879123456"],
      ["0899123456", "+359899123456"],
      // Sofia landline (area code 2, 7 national digits is the historical case;
      // we accept 7–9 national digits to cover both the old 7-digit and the
      // newer 8-digit Sofia numbers).
      ["029876543", "+35929876543"],
      ["+3592345678", "+3592345678"],
    ])("normalises %j → %j", (input, expected) => {
      expect(normalizeBulgarianPhone(input)).toBe(expected);
    });
  });

  describe("rejected inputs", () => {
    it.each([
      [""],
      ["   "],
      // Non-numeric content after the prefix.
      ["+359abc1234567"],
      ["0xy z1234567"],
      // Wrong country code.
      ["+44 20 7946 0958"], // London
      ["+1 415 555 0100"], // San Francisco
      // National-significant number starts with 0 or 1 — invalid in BG plan.
      ["+3590000000"],
      ["01234567"],
      // Too short / too long after stripping prefix.
      ["+359 123"], // 3 digits after country code
      ["+3591234567890"], // 10 digits after country code
      ["0123"],
      // No recognised prefix at all.
      ["1234567890"],
      ["+(123)"],
    ])("rejects %j with null", (input) => {
      expect(normalizeBulgarianPhone(input)).toBeNull();
    });

    it("rejects non-string input defensively", () => {
      // The Zod schema rejects non-strings before this is reached, but the
      // function is documented as returning null on bad shape — keep the
      // defence in case it's ever called from a Drizzle migration script
      // or other Zod-less surface.
      // @ts-expect-error -- intentionally calling with the wrong type
      expect(normalizeBulgarianPhone(undefined)).toBeNull();
      // @ts-expect-error -- intentionally calling with the wrong type
      expect(normalizeBulgarianPhone(null)).toBeNull();
      // @ts-expect-error -- intentionally calling with the wrong type
      expect(normalizeBulgarianPhone(123456789)).toBeNull();
    });
  });
});
