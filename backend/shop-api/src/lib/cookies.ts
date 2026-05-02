import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
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
