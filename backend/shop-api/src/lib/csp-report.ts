/**
 * CSP violation report intake — parsing, noise filtering, rate limiting.
 *
 * Browsers POST two different shapes to a report endpoint, depending on which
 * directive declared the sink:
 *
 *   - **Legacy `report-uri`** — `Content-Type: application/csp-report`, body is
 *     `{ "csp-report": { "blocked-uri": ..., "violated-directive": ..., ... } }`.
 *     This is the original CSP1 / CSP2 mechanism. Modern browsers still emit
 *     this for documents that ONLY declare `report-uri`. Firefox in particular
 *     still preferred report-uri until late-2025 releases.
 *
 *   - **Modern Reporting API v1** — `Content-Type: application/reports+json`,
 *     body is an array of generic Reporting API envelopes:
 *     `[{ "type": "csp-violation", "age": 0, "url": ..., "user_agent": ...,
 *        "body": { "blockedURL": ..., "effectiveDirective": ..., ... } }]`.
 *     This is the Reporting-Endpoints + `report-to` flow. MDN notes browser
 *     support is broad across the latest devices/versions as of March 2026
 *     (but Firefox/Safari were lagging until that window).
 *
 * We accept both because the deployment must work on every supported browser,
 * not just the latest Chromium. The frontend declares BOTH directives in its
 * CSP header (`report-uri` for fallback, `report-to` for modern), and this
 * endpoint absorbs whatever the browser sends.
 *
 * Field-name divergence between the two formats is normalised into a single
 * `NormalisedCspViolation` shape so the downstream logger/metrics layer never
 * has to branch on the wire format.
 *
 * What this module deliberately does NOT do:
 *   - Persist reports to a database. CloudWatch log retention is the
 *     persistence tier; structured Pino events at warn-level are what
 *     CloudWatch Insights queries against.
 *   - Authenticate. Reports are anonymous by design — the violating page
 *     might not have a session, and forcing auth here would hide the most
 *     interesting class of attack (anonymous probing).
 *   - Validate the report comes from "our" origin. The browser is the
 *     trusted reporter; an attacker who can forge POSTs here can also just
 *     send them. Rate-limiting + noise-filter caps the damage, and CloudWatch
 *     spend is bounded by the per-IP token bucket.
 */

/**
 * Normalised internal shape — what downstream loggers / metrics see, regardless
 * of which wire format the browser sent.
 *
 * Names follow the modern Reporting API spelling (camelCase, `blockedURL` etc.)
 * rather than the legacy kebab-case (`blocked-uri`) because the modern form is
 * what new tooling expects, the legacy form was deprecated by the W3C in 2018,
 * and we have to pick one.
 */
export interface NormalisedCspViolation {
  /** "legacy" = application/csp-report, "modern" = application/reports+json. */
  format: "legacy" | "modern";
  /** URL of the document that violated the policy. */
  documentURL: string | null;
  /** URL of the resource that was blocked, or "inline" / "eval" / "" for non-URL violations. */
  blockedURL: string | null;
  /** The directive whose enforcement caused the violation (e.g. "script-src"). */
  effectiveDirective: string | null;
  /** "enforce" for blocked violations, "report" for report-only mode hits. */
  disposition: string | null;
  /** Full original CSP, useful when reproducing the violation locally. */
  originalPolicy: string | null;
  /** URL of the source file that caused the violation (often the document URL). */
  sourceFile: string | null;
  /** Line/column inside sourceFile, if the browser provided them. */
  lineNumber: number | null;
  columnNumber: number | null;
  /** Up to 40-char sample of the violating content (only if `'report-sample'` was set on the directive). */
  sample: string | null;
  /** HTTP status code of the resource fetch the directive blocked. 0 for inline violations. */
  statusCode: number | null;
  /** URL of the referrer of the document that violated the policy. */
  referrer: string | null;
}

/**
 * Parse a single legacy `application/csp-report` body into the normalised shape.
 * The legacy body always carries a single object under the `"csp-report"` key.
 */
export function parseLegacyReport(body: unknown): NormalisedCspViolation | null {
  if (!body || typeof body !== "object") return null;
  const wrapper = body as Record<string, unknown>;
  const inner = wrapper["csp-report"];
  if (!inner || typeof inner !== "object") return null;
  const r = inner as Record<string, unknown>;

  return {
    format: "legacy",
    documentURL: pickString(r, "document-uri"),
    blockedURL: pickString(r, "blocked-uri"),
    // `violated-directive` is the historic name; `effective-directive` was
    // added later. They contain the same value on modern browsers; pick the
    // more specific one when both are present.
    effectiveDirective:
      pickString(r, "effective-directive") ?? pickString(r, "violated-directive"),
    disposition: pickString(r, "disposition"),
    originalPolicy: pickString(r, "original-policy"),
    sourceFile: pickString(r, "source-file"),
    lineNumber: pickNumber(r, "line-number"),
    columnNumber: pickNumber(r, "column-number"),
    sample: pickString(r, "script-sample"),
    statusCode: pickNumber(r, "status-code"),
    referrer: pickString(r, "referrer"),
  };
}

/**
 * Parse a modern `application/reports+json` body — an array of envelopes —
 * into zero or more normalised violations. Non-CSP entries in the array
 * (e.g. Permissions-Policy reports, deprecation reports the browser may have
 * batched alongside) are silently skipped: we route only CSP traffic here,
 * even if a future Reporting-Endpoints config sends other categories to the
 * same URL.
 */
export function parseModernReports(body: unknown): NormalisedCspViolation[] {
  if (!Array.isArray(body)) return [];
  const out: NormalisedCspViolation[] = [];
  for (const entry of body) {
    if (!entry || typeof entry !== "object") continue;
    const env = entry as Record<string, unknown>;
    if (env["type"] !== "csp-violation") continue;
    const inner = env["body"];
    if (!inner || typeof inner !== "object") continue;
    const r = inner as Record<string, unknown>;
    out.push({
      format: "modern",
      documentURL: pickString(r, "documentURL") ?? pickString(env, "url"),
      blockedURL: pickString(r, "blockedURL"),
      effectiveDirective: pickString(r, "effectiveDirective"),
      disposition: pickString(r, "disposition"),
      originalPolicy: pickString(r, "originalPolicy"),
      sourceFile: pickString(r, "sourceFile"),
      lineNumber: pickNumber(r, "lineNumber"),
      columnNumber: pickNumber(r, "columnNumber"),
      sample: pickString(r, "sample"),
      statusCode: pickNumber(r, "statusCode"),
      referrer: pickString(r, "referrer"),
    });
  }
  return out;
}

function pickString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  if (typeof v !== "string") return null;
  if (v.length === 0) return null;
  // Cap individual string fields at 2 KiB — defence against pathological
  // payloads where one field swallows the whole body budget. Real-world
  // CSP fields stay under a few hundred characters.
  return v.length > 2048 ? v.slice(0, 2048) : v;
}

function pickNumber(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Browser extensions are the dominant source of CSP-report noise on any
 * production site — ad blockers, password managers, dark-mode injectors all
 * try to inject scripts into the page and the strict CSP blocks them. None of
 * those are XSS attempts; logging them at warn-level would drown out real
 * signal.
 *
 * The schemes listed below are all extension-origin URI schemes documented by
 * the respective browser vendors. `webkit-masked-url://` is Safari's redaction
 * of cross-origin URIs in some report contexts. `about:` is a non-actionable
 * pseudo-URL.
 *
 * Returns true if the violation should be DOWNGRADED to debug-level (still
 * recorded, but won't trigger alerts). Real-attack signals (script-src
 * violations with no source-file, inline-style violations on form pages, etc)
 * pass through unchanged.
 */
export function isExtensionNoise(v: NormalisedCspViolation): boolean {
  const candidates = [v.blockedURL, v.sourceFile].filter(
    (s): s is string => typeof s === "string",
  );
  for (const c of candidates) {
    if (
      c.startsWith("chrome-extension://") ||
      c.startsWith("moz-extension://") ||
      c.startsWith("safari-extension://") ||
      c.startsWith("safari-web-extension://") ||
      c.startsWith("webkit-masked-url://") ||
      c.startsWith("about:") ||
      c === "null"
    ) {
      return true;
    }
  }
  return false;
}

// ─── Rate limit ────────────────────────────────────────────────────────────
//
// In-memory token-bucket per client IP. CSP reports are a high-volume, low-
// value stream by nature: every `<Link>` mis-load, every flaky extension,
// every overly-curious scanner generates a report. The hard ceiling here
// protects CloudWatch budget and downstream log-processing from a single
// chatty client.
//
// This is the LAST line of defence. The real DDoS defence is upstream at WAF
// (a custom WAF rate-limit rule on the report endpoint takes 5 minutes to
// configure in the AWS console). Per-Lambda-container memory state is enough
// to throttle one buggy extension or one abusive scanner; coordinated floods
// across many IPs will scale up Lambda concurrency, but each container still
// caps its own per-IP rate.

interface RateLimitBucket {
  /** Count of reports accepted from this IP in the current window. */
  count: number;
  /** Epoch-millis when the count resets to 0. */
  resetAt: number;
}

const RATE_LIMIT_MAX_PER_WINDOW = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;
/** Cap the number of distinct IPs we track. Beyond this, oldest entries get evicted. */
const RATE_LIMIT_MAX_TRACKED_IPS = 10_000;

const buckets = new Map<string, RateLimitBucket>();

/**
 * Returns `true` if THIS report from THIS IP is within the budget and should be
 * processed; `false` if the IP has exceeded the per-window cap.
 *
 * Rate-limited reports are dropped silently. The endpoint still returns 204 —
 * surfacing 429 to a browser would just produce console warnings without
 * stopping the violations.
 */
export function tryConsumeRateLimit(ip: string, now: number = Date.now()): boolean {
  const bucket = buckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    // First report from this IP, OR the window expired — reset.
    buckets.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    // Eviction: keep the map size bounded. A real DDoS would otherwise let
    // an attacker fill memory with bogus IP keys.
    if (buckets.size > RATE_LIMIT_MAX_TRACKED_IPS) {
      // Map iteration order is insertion order, so deleting the first entry
      // drops the oldest. O(1) per eviction; not perfect LRU but good enough
      // for this signal.
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) buckets.delete(oldest);
    }
    return true;
  }
  if (bucket.count >= RATE_LIMIT_MAX_PER_WINDOW) {
    return false;
  }
  bucket.count++;
  return true;
}

/**
 * Test-only: forget every tracked IP. Called from per-test setup so the rate
 * limit doesn't carry state between tests. NEVER called in production.
 */
export function _resetRateLimitForTests(): void {
  buckets.clear();
}

/** Test-only: snapshot for assertions. */
export function _peekRateLimitSize(): number {
  return buckets.size;
}

/** Exposed only so the route handler / tests stay in sync with the policy. */
export const RATE_LIMIT_POLICY = {
  maxPerWindow: RATE_LIMIT_MAX_PER_WINDOW,
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxTrackedIps: RATE_LIMIT_MAX_TRACKED_IPS,
} as const;

/**
 * Maximum body size we'll ingest, in bytes. Real CSP reports are well under
 * 4 KiB; the cap is set to 16 KiB to handle modern batched reports comfortably
 * while still rejecting obvious abuse. Bodies above the cap are dropped — the
 * endpoint still returns 204 because retrying would not help the browser.
 */
export const MAX_REPORT_BODY_BYTES = 16 * 1024;
