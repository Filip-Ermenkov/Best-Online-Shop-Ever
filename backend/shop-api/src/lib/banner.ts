/**
 * Pure helpers for the promotional banner / hero-slider slice
 * (docs/README.md §"Управление на банер"; ARCHITECTURE §13). DB-free and
 * AWS-free so they unit-test without booting the app — the same split as
 * `lib/category-tree.ts`, `lib/order-status.ts`, `lib/product-admin.ts`, and
 * `lib/asset-upload.ts`.
 *
 * The one security-critical decision lives here: a banner's click-through link
 * is an admin-entered string, and the slider renders it into an `<a href>`. We
 * therefore accept ONLY a same-origin, path-absolute internal link
 * (`/products/…`, `/search?q=…#moved`) — never an absolute, protocol-relative,
 * or scheme URL. That:
 *   - keeps the promo pointing at the shop's own catalog (the spec says the link
 *     targets „категория или продукт"), not an arbitrary third-party site an
 *     attacker-with-admin or a typo could smuggle in;
 *   - structurally forecloses the `javascript:`/`data:` href XSS vector (those
 *     do not start with `/`) and the protocol-relative open-redirect (`//evil`,
 *     and the `/\evil` backslash trick browsers normalise to `//`);
 *   - means the frontend can bind the value straight into `next/link` without a
 *     second sanitiser — validated once, server-side, at write time.
 *
 * The bytes behind the image key still flow through the presigned-POST +
 * magic-byte validator pipeline (lib/asset-upload.ts); banners are simply the
 * third `kind` that pipeline already mints keys for.
 */

/** Field caps — generous, but bounded so a row can't carry unbounded text. */
export const BANNER_TITLE_MAX = 120;
export const BANNER_SUBTITLE_MAX = 240;
export const BANNER_LINK_MAX = 512;

/**
 * A character is unsafe in an internal href when it is an ASCII control char
 * (code <= 0x1F), a space (0x20), DEL (0x7F), or a backslash (0x5C). All three
 * are exactly what the open-redirect / href-injection tricks rely on, and none
 * is ever legitimate in a link we mint. Implemented as a code-point scan rather
 * than a regex so the intent is unmistakable (and tooling can't quietly
 * re-escape a control-char class).
 */
function hasUnsafeLinkChar(path: string): boolean {
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || code === 0x5c) return true;
  }
  return false;
}

/**
 * True when `path` is a safe, same-origin internal link the slider can render
 * into an `<a href>` without further escaping.
 *
 * Accepted: a single leading `/` followed by a normal path/query/fragment, e.g.
 *   /products/elektronika
 *   /search?q=бормашина
 *   /products/x#moved
 *
 * Rejected (each is a real attack or footgun):
 *   //evil.example      protocol-relative → leaves the site
 *   /\evil.example      backslash variant browsers normalise to //
 *   https://evil…       absolute off-site URL
 *   javascript:alert(1) scheme URL (also fails the leading-/ test)
 *   /a\b, "/a b", "/a\n" backslash / whitespace / control chars
 *
 * The check is intentionally conservative: anything it is not certain about is
 * rejected, because the safe fallback (no link) is harmless.
 */
export function isInternalLinkPath(path: string): boolean {
  if (typeof path !== "string") return false;
  if (path.length === 0 || path.length > BANNER_LINK_MAX) return false;
  // Must be path-absolute.
  if (path[0] !== "/") return false;
  // Reject protocol-relative ("//host") and the backslash trick ("/\host").
  if (path[1] === "/" || path[1] === "\\") return false;
  if (hasUnsafeLinkChar(path)) return false;
  return true;
}

/**
 * Normalise an optional admin-entered link: trims, treats blank as "no link",
 * and returns a discriminated result so the route can map an invalid link to a
 * clean field-level 400 instead of silently dropping it.
 */
export type LinkNormalizeResult =
  | { ok: true; value: string | null }
  | { ok: false; message: string };

export function normalizeBannerLink(
  raw: string | null | undefined,
): LinkNormalizeResult {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (!isInternalLinkPath(trimmed)) {
    return {
      ok: false,
      message:
        "Линкът трябва да е вътрешен адрес, започващ с „/“ (напр. /products/elektronika).",
    };
  }
  return { ok: true, value: trimmed };
}

/**
 * Trim an optional free-text field to `null` when blank. Keeps the DB honest:
 * an empty title is stored as NULL, not "", so „no title" has one representation.
 */
export function normalizeOptionalText(
  raw: string | null | undefined,
): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}
