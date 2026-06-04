import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { parseEnv } from "./env.js";

/**
 * Session cookie attributes — encoded once, here, so every code path that
 * touches the cookie agrees on the contract.
 *
 * The 2026 OWASP Session Management Cheat Sheet stack:
 *
 *   __Host-shop_session=<token>
 *     ; Path=/                           required by __Host- prefix
 *     ; HttpOnly                         JavaScript cannot read it (XSS containment)
 *     ; Secure                           HTTPS-only — required by __Host- prefix
 *     ; SameSite=Lax                     blocks cross-site POST/PUT/DELETE; allows
 *                                        top-level navigation login redirects
 *     ; Max-Age=2592000                  ONLY when rememberMe=true (30 days)
 *
 * Dev fallback (NODE_ENV !== "production"):
 *   - Drop the `__Host-` prefix because Secure cookies don't ride over plain
 *     http://localhost. Name becomes `shop_session`.
 *   - Drop the Secure attribute. Everything else stays the same so the dev
 *     surface matches production behaviour as closely as possible.
 *
 * SameSite trade-off: we picked Lax over Strict.
 *
 *   Strict would block "user clicks a link in an email and lands on /account
 *   already logged in" — that flow is part of the spec's password-reset
 *   journey, and breaking it would fail real-world UX. Lax still blocks the
 *   classic CSRF surface (cross-site POST submissions, image-tag GETs that
 *   trigger mutations on the server). Combined with the API only accepting
 *   `Content-Type: application/json` (which forces a CORS preflight from
 *   any cross-origin caller), this is a strong defensive posture.
 *
 * If the threat model later wants explicit CSRF token defence-in-depth, the
 * pattern is "double-submit cookie" — set a non-HttpOnly XSRF-TOKEN cookie
 * and require an X-CSRF-Token header on mutations. That's an additive change
 * that fits cleanly on top of the current cookie shape.
 */

/** Cookie name. Returned from a function so we can branch on env at call time. */
export function sessionCookieName(): string {
  return parseEnv().NODE_ENV === "production"
    ? "__Host-shop_session"
    : "shop_session";
}

/** 30 days. Same as the spec's "Запомни ме" persistence window. */
export const REMEMBER_ME_MAX_AGE_SEC = 30 * 24 * 60 * 60;

interface SetSessionCookieOpts {
  rememberMe: boolean;
}

export function setSessionCookie(
  c: Context,
  token: string,
  { rememberMe }: SetSessionCookieOpts,
): void {
  const env = parseEnv();
  const isProd = env.NODE_ENV === "production";

  setCookie(c, sessionCookieName(), token, {
    path: "/",
    httpOnly: true,
    secure: isProd,
    sameSite: "Lax",
    // Only set Max-Age when rememberMe — otherwise the browser turns it into a
    // session cookie that dies when the tab/window closes. The server still
    // enforces the 2h idle window on top of that.
    ...(rememberMe ? { maxAge: REMEMBER_ME_MAX_AGE_SEC } : {}),
  });
}

export function clearSessionCookie(c: Context): void {
  const env = parseEnv();
  const isProd = env.NODE_ENV === "production";

  // deleteCookie sets Max-Age=0 with the matching attributes. Path / Secure /
  // sameSite have to match what setSessionCookie set, otherwise some browsers
  // ignore the deletion.
  deleteCookie(c, sessionCookieName(), {
    path: "/",
    secure: isProd,
    sameSite: "Lax",
  });
}

// ─── Visitor (cookie-consent) identifier ──────────────────────────────────
//
// An opaque, pseudonymous identifier used to key cookie-consent receipts (the
// `cookie_consents` table). This cookie is ITSELF strictly necessary — it
// carries no PII, exists only so the controller can tie a stored consent
// record to the browser that gave it (GDPR Art. 7(1): the controller "shall
// be able to demonstrate that the data subject has consented"), and is
// therefore exempt from the very consent it underpins (ePrivacy / EDPB).
//
// Same env-aware naming + attribute stack as the session cookie: `__Host-`
// prefix + Secure in production, both dropped on localhost so the cookie
// rides plain http in dev. HttpOnly because only the server reads it — the
// banner tracks its own visibility in localStorage; the durable, demonstrable
// record lives server-side. SameSite=Lax so the cookie travels on the
// same-site shop → shop-api fetch (the session cookie relies on the same).

/** Cookie name. Branches on env at call time, mirroring sessionCookieName(). */
export function visitorCookieName(): string {
  return parseEnv().NODE_ENV === "production"
    ? "__Host-shop_vid"
    : "shop_vid";
}

/**
 * 365 days. Long enough that the identifier is stable across visits (so a
 * returning visitor's consent receipts share one key), and comfortably inside
 * the 400-day browser cap on cookie lifetime (Chrome since 2022). When the
 * stored consent should be re-asked is a separate, app-level decision driven
 * by the receipt's `recordedAt`, not by this cookie's expiry.
 */
export const VISITOR_COOKIE_MAX_AGE_SEC = 365 * 24 * 60 * 60;

/**
 * Return the caller's visitor id, minting + setting one if the cookie is
 * absent. Idempotent within a browser: a caller that already holds the cookie
 * keeps the same id, so consent receipts written across visits share a stable
 * key. Call this from write paths (recording consent).
 */
export function getOrSetVisitorId(c: Context): string {
  const existing = getCookie(c, visitorCookieName());
  if (existing && existing.length > 0) return existing;

  const isProd = parseEnv().NODE_ENV === "production";
  const id = randomUUID();
  setCookie(c, visitorCookieName(), id, {
    path: "/",
    httpOnly: true,
    secure: isProd,
    sameSite: "Lax",
    maxAge: VISITOR_COOKIE_MAX_AGE_SEC,
  });
  return id;
}

/**
 * Read the visitor id WITHOUT minting one. Read-only paths (e.g. the GDPR data
 * export, which should not create an identifier as a side effect of a read)
 * use this; it returns null when the browser has never recorded consent.
 */
export function getVisitorId(c: Context): string | null {
  return getCookie(c, visitorCookieName()) ?? null;
}
