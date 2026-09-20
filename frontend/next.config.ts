import type { NextConfig } from "next";

/**
 * Baseline security headers applied to every response.
 *
 * Content Security Policy is intentionally NOT set here. The strict nonce-
 * based CSP lives in `frontend/src/proxy.ts` and applies uniformly to every
 * HTML document. Setting a separate CSP here would create the hybrid pattern
 * the May 2026 revision rejected — see ARCHITECTURE.md §5.2 for why. (Tl;dr:
 * a document's CSP is fixed at load time and cannot change on SPA soft
 * navigation, so per-route CSP profiles are silently bypassed by `<Link>`
 * navigation between them. One uniform policy avoids the trap.)
 *
 * Everything else worth setting at the build-config level — HSTS,
 * Permissions-Policy, MIME-sniffing, framing, cross-origin policies — stays
 * here. These headers don't depend on per-request randomness so they fit
 * `next.config.ts`'s static configuration model perfectly.
 *
 * References:
 *   - https://nextjs.org/docs/app/guides/content-security-policy
 *   - MDN Permissions-Policy / Referrer-Policy specs
 */

const isProd = process.env.NODE_ENV === "production";

/**
 * Permissions-Policy: turn off browser features the shop has no business
 * using. If a future page or third-party script tries to enable them they
 * will be silently denied — that's the point. Each `feature=()` is an
 * explicit empty allow-list.
 *
 * Removed directives (Chrome 2026 unrecognised — they were either dropped
 * from the Permissions-Policy registry, never made it from Feature-Policy,
 * or are gated behind specific origin-trial flags):
 *   - ambient-light-sensor — removed from the spec; sensor access uses
 *     `accelerometer` family instead
 *   - battery — Battery Status API is deprecated; Permissions-Policy
 *     doesn't enumerate it anymore
 *   - document-domain — `document.domain` setter is being phased out; the
 *     Permissions-Policy entry was removed when the underlying API was
 *     gated behind a new origin-isolation model
 *
 * The remaining directives are the 2026 stable set per MDN.
 */
const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "autoplay=()",
  "camera=()",
  "display-capture=()",
  "encrypted-media=()",
  "fullscreen=(self)",
  "gamepad=()",
  "geolocation=()",
  "gyroscope=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "picture-in-picture=()",
  "publickey-credentials-get=()",
  "screen-wake-lock=()",
  "sync-xhr=()",
  "usb=()",
  "web-share=(self)",
  "xr-spatial-tracking=()",
  "browsing-topics=()",
  "interest-cohort=()",
].join(", ");

const baselineSecurityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
  // X-Frame-Options is technically redundant with frame-ancestors 'none',
  // but ships separately for older browsers that don't honour CSP3
  // frame-ancestors (Firefox <33, Safari <10). Both should always agree.
  { key: "X-Frame-Options", value: "DENY" },
  // Cross-origin policies: lock the document down by default. These have
  // ~zero compatibility cost for an e-commerce shop with no embedded
  // iframes / cross-origin images of its own (the CloudFront subdomain
  // is same-site under duda1.shop).
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-site" },
];

// HSTS is only emitted in production builds. Local dev runs over HTTP, and
// pinning HSTS on http://localhost forces the browser to refuse plain HTTP
// to localhost for `max-age` seconds — a nasty footgun. CloudFront also
// sets HSTS in prod via the response headers policy (when that gets
// configured); setting it from the origin too is harmless duplication
// because both header values are identical.
const productionOnlyHeaders = isProd
  ? [
      {
        key: "Strict-Transport-Security",
        value: "max-age=63072000; includeSubDomains; preload",
      },
    ]
  : [];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // Match every path. _next/static and _next/image are also covered;
        // those routes need the same baseline security headers as everything
        // else. Only API routes (proxied via the shop-api Lambda) are
        // outside the Next.js process and therefore unaffected.
        source: "/:path*",
        headers: [...baselineSecurityHeaders, ...productionOnlyHeaders],
      },
    ];
  },
};

export default nextConfig;
