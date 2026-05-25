import { NextResponse, type NextRequest } from "next/server";

/**
 * Next.js 16 proxy (formerly middleware.ts).
 *
 * Two responsibilities here, both intentionally kept thin:
 *
 *   1. Auth-aware routing. The 2026 Next.js best practice is the "thin
 *      proxy" pattern — optimistic cookie-presence check only. Never call
 *      the API or DB here — proxies run on every navigation including
 *      prefetches, so even a fast call adds latency to every transition.
 *      Real authorisation lives in the page (or the data fetch the page
 *      awaits). The proxy just stops obviously-anonymous traffic from
 *      reaching protected pages, saving a server-component fetch + a
 *      client-side flicker. This is the same pattern Better Auth,
 *      Auth.js, and Clerk all converged on for Next.js 15+. The cookie
 *      value is opaque to us (it's a base64url SHA-256-hashed session
 *      token whose only authority is the sessions table at the API).
 *
 *   2. Strict per-request Content Security Policy for EVERY route. We
 *      generate a fresh base64-encoded 128-bit nonce on every request
 *      and set both `Content-Security-Policy` (with `'nonce-X' 'strict-
 *      dynamic'`) and a forwarded `x-nonce` header so Server Components
 *      can read it via `headers()` and pass it to `<Script>` if they
 *      ever load a third-party tag. Next.js 16 auto-attaches the nonce
 *      to framework and page-bundle scripts when it sees the CSP header
 *      in the request (see Next.js CSP guide).
 *
 *      **Why uniform and not hybrid.** An earlier May 2026 revision
 *      shipped a Profile-A/Profile-B hybrid: strict CSP on /account
 *      + /admin via this proxy, lax baseline (`'unsafe-inline'`) on
 *      catalog routes via next.config.ts. That model has a SPA soft-
 *      navigation hole: a document's CSP is fixed at load, so a user
 *      landing on / and then `<Link>`-navigating to /account/login
 *      keeps `/`'s relaxed CSP. The cross-boundary security guarantee
 *      simply doesn't exist for that traffic pattern. The fix is to
 *      use one uniform strict policy everywhere; clicking between
 *      catalog and account then never crosses a boundary because both
 *      sides are equally locked down. The Next.js root layout already
 *      reads cookies via getServerUser(), which forces dynamic
 *      rendering, so we weren't actually getting ISR on catalog pages
 *      anyway — uniform CSP just makes that fact honest. ARCHITECTURE.md
 *      §5.2 carries the full reasoning.
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
  // The email-change verify link lands here. The link is delivered to
  // the NEW address, which may be opened on a device that has never
  // logged in to the shop (a phone, a work laptop, etc). Gating it
  // behind a session would force the user to log in first — and they
  // may not even remember the OLD password if they're mid-recovery.
  // Token validation happens at the API layer.
  "/account/email-change/verify",
];

function hasSessionCookie(req: NextRequest): boolean {
  return SESSION_COOKIE_NAMES.some((name) => req.cookies.has(name));
}

function isPublicAccountPath(path: string): boolean {
  return PUBLIC_ACCOUNT_PATHS.some(
    (p) => path === p || path.startsWith(`${p}/`),
  );
}

// Origins this CSP needs to allow. Same source-of-truth as next.config.ts —
// repeated here on purpose: next.config.ts runs in the build/server bundle,
// proxy.ts in the runtime proxy bundle, and they don't share modules without
// awkward import paths. Drift between them is caught by the curl-headers
// verification in ARCHITECTURE.md §5.2.4.
const isProd = process.env.NODE_ENV === "production";
const API_ORIGIN = isProd
  ? "https://shop-api.duda1.bg"
  : "http://localhost:3001";
const IMG_ORIGIN = "https://cdn.duda1.bg";

/**
 * CSP violation report sink. Both the legacy `report-uri` directive and the
 * modern Reporting-Endpoints + `report-to` directive point at this URL — the
 * server-side handler in `backend/shop-api/src/routes/csp.ts` accepts both
 * payload shapes on the same endpoint. Using the absolute URL on a sibling
 * subdomain (shop-api.duda1.bg) means the reports travel cross-origin; that
 * is fine because the cors() middleware on the API already allowlists the
 * shop's origin, AND the Reporting API spec explicitly supports cross-origin
 * endpoints.
 */
const CSP_REPORT_URL = `${API_ORIGIN}/csp-report`;

// Dev-only image origins. The seed data and the dev banner component pull
// placeholder images from `placehold.co`. In production those slots are
// filled by the admin pointing at real images on `cdn.duda1.bg`, so the
// placeholder origin is intentionally NOT allowed in prod — leaking
// `placehold.co` references into production HTML would be a content bug
// the strict CSP correctly catches. Add new dev-only image hosts here.
const DEV_IMG_ORIGINS = isProd ? "" : " https://placehold.co";

/**
 * Generate a per-request nonce. Per Next.js 16 official guide
 * (https://nextjs.org/docs/app/guides/content-security-policy), the
 * recommended pattern is `Buffer.from(crypto.randomUUID()).toString('base64')`
 * which produces a 36-char base64 over the 16-byte UUID. We use the same.
 *
 * Why this is enough entropy: 122 random bits exceeds the 96-bit threshold
 * the W3C CSP3 spec recommends as the floor for `nonce-source`. An attacker
 * with 2^61 guesses-per-second would need >10^15 years on average to forge
 * a single matching value within the request lifetime.
 */
function generateNonce(): string {
  return Buffer.from(crypto.randomUUID()).toString("base64");
}

/**
 * Build the strict CSP applied to /account/* and /admin/*. Uses
 * `'strict-dynamic'`: any script the page loads (or that one of those
 * scripts dynamically inserts) must carry the matching nonce, period.
 * `'self'`, `https:`, etc. are ignored in the presence of strict-dynamic
 * per CSP3 spec — that's the whole point. This is the defence model
 * OWASP recommends for stored-XSS-resistant applications.
 *
 * `'unsafe-eval'` is conditionally added in development because React's
 * dev-mode debugging uses `eval` to reconstruct server-component stack
 * traces. Next.js's own docs flag this trade-off; it is NOT included in
 * production.
 */
function buildStrictCsp(nonce: string): string {
  const directives = [
    "default-src 'self'",
    // `'report-sample'` asks the browser to include a 40-char excerpt of the
    // violating content in the report body (CSP3 §6.6.4). Without it, violations
    // arrive with `sample: ""` which makes debugging "what script tried to run"
    // a guessing game. The privacy cost is tiny — the sample is bounded and
    // travels to the report endpoint we control.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'report-sample'${isProd ? "" : " 'unsafe-eval'"}`,
    // Style nonce in prod; dev needs 'unsafe-inline' because some HMR
    // injection paths can't reach the proxy's nonce.
    isProd
      ? `style-src 'self' 'nonce-${nonce}' 'report-sample'`
      : "style-src 'self' 'unsafe-inline'",
    `img-src 'self' blob: data: ${IMG_ORIGIN}${DEV_IMG_ORIGINS}`,
    "font-src 'self' data:",
    `connect-src 'self' ${API_ORIGIN}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
    // Modern Reporting API v1 directive (used with `Reporting-Endpoints`
    // response header — see withStrictCsp below). The token MUST match the
    // endpoint NAME declared in Reporting-Endpoints, NOT a URL.
    "report-to csp-endpoint",
    // Legacy CSP1/CSP2 fallback for browsers that don't yet support the
    // Reporting API (older Firefox/Safari versions still in the long tail
    // through 2026). The two coexist cleanly: modern browsers honour
    // report-to and ignore report-uri; older browsers do the reverse.
    `report-uri ${CSP_REPORT_URL}`,
  ];
  return directives.join("; ");
}

/**
 * Attach the strict CSP and forwarded `x-nonce` to a response. Works for
 * both passthrough (NextResponse.next()) and redirect responses — every
 * path the proxy returns goes through this helper so the response header
 * set is consistent. (Redirects don't render a body, so the CSP on them
 * is purely belt-and-braces — but it also means tooling that fetches with
 * `redirect: 'manual'` sees the policy and doesn't report a false miss.)
 *
 * Two distinct things happen here:
 *
 *   1. The nonce is stamped onto the REQUEST headers (`x-nonce` and a
 *      mirror of `content-security-policy`). Next.js reads this when
 *      rendering Server Components and auto-attaches the nonce to its
 *      framework scripts — that's why pages don't break on first load
 *      under strict-dynamic. The mirror of the CSP header itself is what
 *      Next.js parses for the `'nonce-X'` token.
 *
 *   2. The CSP is stamped onto the RESPONSE headers. This is what the
 *      browser enforces.
 *
 * The two are not the same header in different places — they happen to
 * share a name but serve different ends of the request lifecycle.
 */
function withStrictCsp(req: NextRequest, response: NextResponse): NextResponse {
  const nonce = generateNonce();
  const csp = buildStrictCsp(nonce);

  // The `Reporting-Endpoints` header is the mapping between the endpoint
  // NAME referenced in the CSP's `report-to csp-endpoint` directive and the
  // actual URL the browser POSTs to. It is the modern (Reporting API v1)
  // replacement for the deprecated `Report-To` JSON-blob header — MDN flags
  // that the Reporting API has been broadly supported across the latest
  // browser versions since March 2026, which makes 2026 the year to standardise
  // on this shape.
  //
  // The endpoint NAME `csp-endpoint` is arbitrary — it just has to match
  // between this response header and the `report-to` directive on the CSP.
  // We use a descriptive name so the same map can later carry
  // `permissions-endpoint`, `coop-endpoint`, etc. without renaming.
  const reportingEndpoints = `csp-endpoint="${CSP_REPORT_URL}"`;

  // Forwarded request headers — see (1) above. NextResponse.next() is the
  // one place these can be set in Next.js 16; on a redirect response we
  // can't forward request headers (there are no Server Components to read
  // them downstream), so the redirect branch only sets the response CSP.
  if (response.headers.has("location")) {
    // It's a redirect — only response CSP applies.
    response.headers.set("Content-Security-Policy", csp);
    response.headers.set("Reporting-Endpoints", reportingEndpoints);
    return response;
  }

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  const out = NextResponse.next({
    request: { headers: requestHeaders },
    status: response.status,
    headers: response.headers,
  });
  out.headers.set("Content-Security-Policy", csp);
  out.headers.set("Reporting-Endpoints", reportingEndpoints);
  return out;
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
    return withStrictCsp(req, NextResponse.redirect(url));
  }

  // Anonymous users hitting any /account/* page (other than the public auth
  // entry points) get bounced to login with a ?next= hint so they land on
  // the originally-requested page after signing in.
  if (!loggedIn && pathname.startsWith("/account/") && !isPublicAccountPath(pathname)) {
    const url = req.nextUrl.clone();
    url.pathname = "/account/login";
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
    return withStrictCsp(req, NextResponse.redirect(url));
  }

  // /admin/* requires SOME session. The proxy can't tell admin from customer
  // (the cookie is opaque). Real role check happens in the admin layout —
  // a customer with a session lands on /admin, hits the layout's role check,
  // and gets a 403 there. Keeping role enforcement at the data layer means
  // the cookie remains opaque and we don't have to decode session state in
  // the proxy runtime.
  if (!loggedIn && pathname.startsWith("/admin")) {
    const url = req.nextUrl.clone();
    url.pathname = "/account/login";
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
    return withStrictCsp(req, NextResponse.redirect(url));
  }

  // Passthrough — full strict-CSP application including forwarded x-nonce.
  return withStrictCsp(req, NextResponse.next());
}

/**
 * Matcher rationale. The proxy now runs on every HTML-document request so
 * the strict CSP applies uniformly. We exclude:
 *
 *   - `_next/static`, `_next/image`, `favicon.ico` — Next.js internal
 *     paths that serve compiled JS / images / icons. They never render
 *     HTML, so CSP has nothing to apply to.
 *   - `api/*` — Next.js API routes (none today; reserved for any future
 *     in-process handler). They return JSON, not HTML, and shouldn't carry
 *     a document CSP. The CSP violation report sink lives at
 *     `${API_ORIGIN}/csp-report` on the backend, not here — see the
 *     CSP_REPORT_URL constant and ARCHITECTURE.md §15 item 14.
 *   - Prefetch requests — `<Link>` prefetches RSC payloads, not full
 *     documents. The `missing` clauses filter those out so we don't
 *     generate nonces (and incur Node-runtime startup cost) for traffic
 *     that has no visible CSP application. The two header names cover
 *     both the App Router prefetch path (`next-router-prefetch`) and
 *     the underlying fetch API hint (`purpose: prefetch`).
 *
 * The Node-runtime cost of ~1 ms per request is negligible at every
 * traffic tier the architecture is designed for; see ARCHITECTURE.md
 * §10 for the cost analysis.
 */
export const config = {
  matcher: [
    {
      source:
        "/((?!api|_next/static|_next/image|favicon.ico|.well-known).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
