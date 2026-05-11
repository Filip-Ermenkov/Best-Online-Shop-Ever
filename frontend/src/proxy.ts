import { NextResponse, type NextRequest } from "next/server";

/**
 * Next.js 16 proxy (formerly middleware.ts).
 *
 * The 2026 Next.js best practice is the "thin proxy" pattern:
 *
 *   - Optimistic, cookie-presence-only check. Never call the API or DB
 *     here — proxies run on every navigation including prefetches, so
 *     even a fast call adds latency to every page transition.
 *   - Real authorisation lives in the page (or the data fetch the page
 *     awaits). The proxy just stops obviously-anonymous traffic from
 *     reaching protected pages, saving a server-component fetch + a
 *     client-side flicker.
 *
 * This is the same pattern Better Auth, Auth.js, and Clerk all converged
 * on for Next.js 15+. We label the cookie-presence check "NOT secure on
 * its own" and rely on the API to actually validate the token: the
 * cookie value here is opaque to us anyway (it's a base64url SHA-256-hashed
 * session token whose only authority is the sessions table).
 */

// Names match what the backend sets — see backend/shop-api/src/lib/cookies.ts.
//   Production:  __Host-shop_session  (Secure, HTTPS-only)
//   Development: shop_session         (no __Host- prefix because dev is http)
const SESSION_COOKIE_NAMES = ["__Host-shop_session", "shop_session"];

/**
 * Paths under /account that anonymous visitors are allowed to reach.
 *
 * The two recovery flows — verify-email and reset-password — MUST be public.
 * The link in the email IS the proof of identity for those flows; the user
 * may legitimately click from any device, including one that has never
 * logged in (a phone after registering on a desktop, for example). Gating
 * them behind a session would force the user to log in first, which is
 * precisely the wrong UX for a "I forgot how to log in" recovery path.
 *
 * Token validation still happens at the API layer — the proxy just gets out
 * of the way and lets the page mount.
 */
const PUBLIC_ACCOUNT_PATHS = [
  "/account/login",
  "/account/register",
  "/account/forgot-password",
  "/account/reset-password",
  "/account/verify-email",
];

function hasSessionCookie(req: NextRequest): boolean {
  return SESSION_COOKIE_NAMES.some((name) => req.cookies.has(name));
}

function isPublicAccountPath(path: string): boolean {
  return PUBLIC_ACCOUNT_PATHS.some(
    (p) => path === p || path.startsWith(`${p}/`),
  );
}

export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const loggedIn = hasSessionCookie(req);

  // Authenticated users hitting login/register are bounced to their account
  // — kinder UX than letting them log in twice and confuse the SSR header.
  if (loggedIn && (pathname === "/account/login" || pathname === "/account/register")) {
    const url = req.nextUrl.clone();
    url.pathname = "/account/profile";
    url.search = "";
    return NextResponse.redirect(url);
  }

  // Anonymous users hitting any /account/* page (other than the public auth
  // entry points) get bounced to login with a ?next= hint so they land on
  // the originally-requested page after signing in.
  if (!loggedIn && pathname.startsWith("/account/") && !isPublicAccountPath(pathname)) {
    const url = req.nextUrl.clone();
    url.pathname = "/account/login";
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  // /admin/* requires SOME session. The proxy can't tell admin from customer
  // (the cookie is opaque). Real role check happens in the admin layout —
  // a customer with a session lands on /admin, hits the layout's role check,
  // and gets a 403 there. Keeping role enforcement at the data layer means
  // the cookie remains opaque and we don't have to decode session state in
  // the edge runtime.
  if (!loggedIn && pathname.startsWith("/admin")) {
    const url = req.nextUrl.clone();
    url.pathname = "/account/login";
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

/**
 * Limit the proxy to paths that actually need auth-aware routing. Without
 * a matcher, the proxy runs on every static asset request too, which is
 * wasted work (and Next 16 made the proxy default to Node runtime, which
 * is slower than the old edge default).
 *
 * Order: most specific first. The negative lookahead at the end skips
 * Next's internal paths and any file with an extension (assets).
 */
export const config = {
  matcher: [
    "/account/:path*",
    "/admin/:path*",
  ],
};
