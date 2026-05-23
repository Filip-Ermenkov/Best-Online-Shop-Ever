/**
 * Bulgarian phone-number normalisation to E.164.
 *
 * Why a hand-rolled normaliser instead of `libphonenumber-js`?
 *
 *   - libphonenumber-js core + BG metadata adds ~5 KB to the Lambda cold-start
 *     ZIP today, but the full package adds ~120 KB and the tree-shaken core
 *     wires up an extra build step (custom metadata generation) that nothing
 *     else in this monorepo needs. The shop only ever validates ONE country.
 *   - The Bulgarian numbering plan is small and stable: country code +359,
 *     national-significant numbers are 7–9 digits starting with 2–9. We can
 *     express the constraint inline in 20 lines.
 *   - When (if) the project expands to multi-country support, swap this
 *     function for libphonenumber-js's `parsePhoneNumberFromString()` —
 *     the signature (string → E.164 or null) is intentionally the same shape
 *     so the call sites don't change.
 *
 * Inputs accepted:
 *   - E.164                       "+359 88 812 3456"
 *   - International long-distance "00359 88 812 3456"
 *   - National with trunk prefix  "088 812 34 56"
 *
 * Whitespace, dashes, dots, parentheses are stripped. Letters / other
 * characters cause rejection (null).
 *
 * National-significant number rules (conservative; covers all current BG
 * numbering ranges):
 *   - 7–9 digits long.
 *   - First digit is 2–9 (1 is reserved for emergency / special services;
 *     0 is the trunk prefix and is stripped above).
 *
 * Mobile (087/088/089 in national form, i.e. +359 87/88/89 in E.164) is
 * the practical case for an e-commerce shop. Landlines are also accepted
 * because nothing in the order-fulfilment flow excludes them.
 *
 * Output: canonical E.164 string `+359` + national digits, OR null on
 * rejection.
 */
export function normalizeBulgarianPhone(input: string): string | null {
  if (typeof input !== "string") return null;

  // Strip everything humans typically use as separators.
  const cleaned = input.replace(/[\s\-().]/g, "").trim();
  if (!cleaned) return null;

  // Peel off the international / trunk prefix and extract the national
  // significant number.
  let national: string;
  if (cleaned.startsWith("+359")) national = cleaned.slice(4);
  else if (cleaned.startsWith("00359")) national = cleaned.slice(5);
  else if (cleaned.startsWith("0")) national = cleaned.slice(1);
  else return null;

  // After stripping the prefix the remainder must be pure digits.
  if (!/^[2-9]\d{6,8}$/.test(national)) return null;

  return `+359${national}`;
}
