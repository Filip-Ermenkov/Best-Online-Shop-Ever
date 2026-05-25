import { OpenAPIHono } from "@hono/zod-openapi";
import type { Logger } from "pino";
import { logger as baseLogger } from "../lib/logger.js";
import {
  MAX_REPORT_BODY_BYTES,
  RATE_LIMIT_POLICY,
  isExtensionNoise,
  parseLegacyReport,
  parseModernReports,
  tryConsumeRateLimit,
  type NormalisedCspViolation,
} from "../lib/csp-report.js";

/**
 * CSP violation report sink.
 *
 * `POST /csp-report` is the URL declared on the frontend's CSP header in two
 * places:
 *
 *   - `Reporting-Endpoints: csp-endpoint="<this URL>"` + `report-to
 *     csp-endpoint` directive on the CSP — the modern Reporting API path,
 *     sending `Content-Type: application/reports+json` with an array of
 *     report envelopes.
 *   - `report-uri <this URL>` directive on the CSP — the legacy CSP1/CSP2
 *     path, sending `Content-Type: application/csp-report` with a single
 *     wrapped object.
 *
 * Both content types land here; the handler decides which parser to call by
 * sniffing the request header. The route is intentionally NOT placed inside
 * `/auth/*` or behind `currentUser` — reports must be reachable anonymously,
 * because the document that triggered the violation might itself be the
 * anonymous public landing page.
 *
 * Response semantics: ALWAYS 204 No Content, regardless of whether the body
 * was valid, parseable, rate-limited, or oversized. The W3C Reporting API
 * spec says reporters must not retry on errors and treats any 2xx as success
 * — surfacing 4xx here would only generate browser-console noise without
 * preventing the next violation. The only thing the server can usefully do
 * is record what arrived and move on.
 *
 * What gets logged:
 *   - Every well-formed CSP violation gets a Pino `warn`-level event with
 *     `event: "csp_violation"` and the normalised fields. CloudWatch
 *     Insights queries can pivot on `effectiveDirective`, `blockedURL`,
 *     `documentURL`, etc.
 *   - Browser-extension noise (chrome-extension://, moz-extension://, …) is
 *     downgraded to `debug` so it doesn't trigger alerts but is still
 *     discoverable if a developer is looking for it specifically.
 *   - Rate-limited / oversized / unparseable submissions get a structured
 *     `info` event noting the drop reason — useful when investigating
 *     "why didn't we see report X" questions.
 *
 * Audit-trail note: there is deliberately no `admin_audit_log` row written
 * here. CSP reports are unauthenticated, untrusted-source telemetry. They
 * belong in CloudWatch Logs, not in the auditable database journal.
 */

type CspApp = OpenAPIHono;

export const cspRoutes: CspApp = new OpenAPIHono();

cspRoutes.post("/", async (c) => {
  const log: Logger = (c.get("logger") as Logger | undefined) ?? baseLogger;
  const ip = clientIp(c);

  // 1. Rate limit. Drop silently above the per-window cap.
  if (!tryConsumeRateLimit(ip)) {
    log.info(
      { event: "csp_report_drop", reason: "rate_limited", ip },
      "csp_report_drop",
    );
    return c.body(null, 204);
  }

  // 2. Body size cap. Read the raw text and check length BEFORE attempting
  //    to parse — pathological payloads should never reach JSON.parse.
  let rawBody: string;
  try {
    rawBody = await c.req.text();
  } catch {
    // The body couldn't even be read — treat as drop.
    log.info(
      { event: "csp_report_drop", reason: "body_read_failed", ip },
      "csp_report_drop",
    );
    return c.body(null, 204);
  }
  if (rawBody.length > MAX_REPORT_BODY_BYTES) {
    log.info(
      {
        event: "csp_report_drop",
        reason: "oversize",
        ip,
        bodyBytes: rawBody.length,
      },
      "csp_report_drop",
    );
    return c.body(null, 204);
  }
  if (rawBody.length === 0) {
    // Some browsers send an empty body on certain violation types. Not an
    // error, but nothing to log either.
    return c.body(null, 204);
  }

  // 3. Parse. JSON.parse failures are silently dropped — a malformed report
  //    is a buggy browser, not an emergency.
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    log.info(
      { event: "csp_report_drop", reason: "invalid_json", ip },
      "csp_report_drop",
    );
    return c.body(null, 204);
  }

  // 4. Normalise. Sniff content-type to pick the right parser.
  const contentType = (c.req.header("content-type") ?? "").toLowerCase();
  const violations: NormalisedCspViolation[] = contentType.includes(
    "application/reports+json",
  )
    ? parseModernReports(parsed)
    : (() => {
        // Default to the legacy single-object format if the content-type is
        // application/csp-report, application/json, or missing entirely
        // (some browsers omit it). If the body is in modern array form but
        // missing the content-type hint, we still try modern as a fallback
        // so well-meaning clients don't get dropped.
        const legacy = parseLegacyReport(parsed);
        if (legacy) return [legacy];
        return parseModernReports(parsed);
      })();

  if (violations.length === 0) {
    log.info(
      { event: "csp_report_drop", reason: "unrecognised_shape", ip },
      "csp_report_drop",
    );
    return c.body(null, 204);
  }

  // 5. Emit one structured log per violation. We do NOT batch multiple
  //    violations into a single log line — keeping one violation per record
  //    makes CloudWatch Insights aggregations (count-by-directive,
  //    count-by-document) work without parsing nested arrays.
  for (const v of violations) {
    const level = isExtensionNoise(v) ? "debug" : "warn";
    log[level](
      {
        event: "csp_violation",
        format: v.format,
        ip,
        userAgent: c.req.header("user-agent") ?? null,
        documentURL: v.documentURL,
        blockedURL: v.blockedURL,
        effectiveDirective: v.effectiveDirective,
        disposition: v.disposition,
        sourceFile: v.sourceFile,
        lineNumber: v.lineNumber,
        columnNumber: v.columnNumber,
        sample: v.sample,
        statusCode: v.statusCode,
        referrer: v.referrer,
        // originalPolicy is intentionally OMITTED — it can be multiple KiB and
        // is the same string on every report. Re-derive it from the live
        // header (Network tab) if a developer needs to inspect it.
      },
      "csp_violation",
    );
  }

  return c.body(null, 204);
});

/**
 * Resolve a stable client-IP key for the rate limiter.
 *
 * Production hits this through CloudFront → Lambda Function URL, where the
 * real client IP is the FIRST entry of `X-Forwarded-For`. CloudFront strips
 * any pre-existing XFF and re-writes it with the client's address, so we
 * trust the first hop. Behind WAF the same is true.
 *
 * Local dev (Node server) puts the remote address on Node's `IncomingMessage.
 * socket.remoteAddress`, but Hono doesn't surface that as a portable header.
 * The dev fallback is the `host` header or a literal string — collisions
 * here just mean multiple dev requests share the same bucket, which is fine.
 *
 * The vitest suite calls `app.request(...)` without any HTTP socket, so the
 * fallback is `"test"`. Tests that exercise rate limiting either call
 * `_resetRateLimitForTests()` between iterations or pass a synthetic
 * `X-Forwarded-For` header to use a deterministic key.
 *
 * Note on RATE_LIMIT_POLICY: the constants are imported so any consumer (the
 * future admin metrics page, the test suite) reads them from a single source.
 * No magic numbers duplicated between this file and csp-report.ts.
 */
function clientIp(c: import("hono").Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = c.req.header("x-real-ip");
  if (real) return real;
  return "test";
}

export { RATE_LIMIT_POLICY };
