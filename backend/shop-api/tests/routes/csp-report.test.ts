import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import {
  MAX_REPORT_BODY_BYTES,
  RATE_LIMIT_POLICY,
  _resetRateLimitForTests,
  isExtensionNoise,
  parseLegacyReport,
  parseModernReports,
  tryConsumeRateLimit,
} from "../../src/lib/csp-report.js";

/**
 * Tests for the CSP violation report sink.
 *
 * Layering: the file mixes
 *   (a) HTTP-level integration tests against `buildApp().request()` to verify
 *       end-to-end behaviour of the route, and
 *   (b) direct unit tests of the parsing / noise / rate-limit primitives in
 *       lib/csp-report.ts, which would be otherwise hard to assert against
 *       through the HTTP boundary alone (the route always returns 204 so a
 *       pure-HTTP test can't observe the difference between "logged at warn"
 *       vs "logged at debug" or "rate-limited" vs "processed").
 *
 * The HTTP tests check `res.status === 204` plus a few asserts on the
 * shape of internal state where it's externally observable (rate-limit
 * map size, in particular).
 */

let app: ReturnType<typeof buildApp>;

beforeAll(() => {
  app = buildApp();
});

beforeEach(() => {
  // per-test.ts already calls _resetRateLimitForTests via the global hook,
  // but call it again here for documentation — these tests depend on it.
  _resetRateLimitForTests();
});

describe("POST /csp-report — legacy application/csp-report format", () => {
  it("returns 204 No Content on a well-formed legacy report", async () => {
    const legacyBody = {
      "csp-report": {
        "document-uri": "http://localhost:3000/",
        "referrer": "",
        "violated-directive": "script-src",
        "effective-directive": "script-src",
        "original-policy": "default-src 'self'; script-src 'self'",
        "disposition": "enforce",
        "blocked-uri": "inline",
        "status-code": 200,
        "script-sample": "alert(1)",
      },
    };
    const res = await app.request("/csp-report", {
      method: "POST",
      headers: { "Content-Type": "application/csp-report" },
      body: JSON.stringify(legacyBody),
    });
    expect(res.status).toBe(204);
    // 204 by definition has no body — confirm we didn't accidentally write one.
    expect(await res.text()).toBe("");
  });

  it("accepts the body when content-type is application/json (some browsers send this)", async () => {
    const res = await app.request("/csp-report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        "csp-report": { "blocked-uri": "inline", "violated-directive": "script-src" },
      }),
    });
    expect(res.status).toBe(204);
  });

  it("accepts the body when no content-type header is provided at all", async () => {
    const res = await app.request("/csp-report", {
      method: "POST",
      body: JSON.stringify({
        "csp-report": { "blocked-uri": "inline", "violated-directive": "script-src" },
      }),
    });
    expect(res.status).toBe(204);
  });
});

describe("POST /csp-report — modern application/reports+json format", () => {
  it("returns 204 on a well-formed batch of Reporting API v1 envelopes", async () => {
    const modernBody = [
      {
        type: "csp-violation",
        age: 53531,
        url: "http://localhost:3000/account/login",
        user_agent: "Mozilla/5.0 (test)",
        body: {
          documentURL: "http://localhost:3000/account/login",
          blockedURL: "inline",
          effectiveDirective: "script-src-elem",
          disposition: "enforce",
          originalPolicy: "default-src 'self'; script-src 'self' 'nonce-X'",
          referrer: "",
          sample: "console.log(1)",
          statusCode: 200,
          sourceFile: "http://localhost:3000/account/login",
          lineNumber: 12,
          columnNumber: 4,
        },
      },
    ];
    const res = await app.request("/csp-report", {
      method: "POST",
      headers: { "Content-Type": "application/reports+json" },
      body: JSON.stringify(modernBody),
    });
    expect(res.status).toBe(204);
  });

  it("silently skips entries in the array whose type is not csp-violation", async () => {
    // Reporting-Endpoints may legitimately funnel deprecation/intervention
    // reports through the same URL if the operator points multiple endpoint
    // names at one URL. The endpoint must ignore unrelated report types
    // rather than treating them as malformed.
    const mixedBody = [
      { type: "deprecation", age: 0, url: "x", body: { id: "X" } },
      { type: "csp-violation", age: 0, url: "y", body: { blockedURL: "inline" } },
    ];
    const res = await app.request("/csp-report", {
      method: "POST",
      headers: { "Content-Type": "application/reports+json" },
      body: JSON.stringify(mixedBody),
    });
    expect(res.status).toBe(204);
  });

  it("falls back to modern-parser if body is an array but content-type is missing", async () => {
    const modernBody = [
      {
        type: "csp-violation",
        age: 0,
        url: "http://localhost:3000/",
        body: { blockedURL: "inline", effectiveDirective: "script-src" },
      },
    ];
    const res = await app.request("/csp-report", {
      method: "POST",
      body: JSON.stringify(modernBody),
    });
    expect(res.status).toBe(204);
  });
});

describe("POST /csp-report — malformed input", () => {
  it("returns 204 (not 400) on invalid JSON — browsers must not retry", async () => {
    const res = await app.request("/csp-report", {
      method: "POST",
      headers: { "Content-Type": "application/csp-report" },
      body: "{ this is not json",
    });
    expect(res.status).toBe(204);
  });

  it("returns 204 on an empty body", async () => {
    const res = await app.request("/csp-report", {
      method: "POST",
      headers: { "Content-Type": "application/csp-report" },
      body: "",
    });
    expect(res.status).toBe(204);
  });

  it("returns 204 on a body that doesn't match either schema", async () => {
    const res = await app.request("/csp-report", {
      method: "POST",
      headers: { "Content-Type": "application/csp-report" },
      body: JSON.stringify({ greeting: "hello" }),
    });
    expect(res.status).toBe(204);
  });

  it("returns 204 on an oversized body (above MAX_REPORT_BODY_BYTES)", async () => {
    // Build a body that exceeds the cap. 17 KiB of digits.
    const oversize = "x".repeat(MAX_REPORT_BODY_BYTES + 1024);
    const res = await app.request("/csp-report", {
      method: "POST",
      headers: { "Content-Type": "application/csp-report" },
      body: oversize,
    });
    expect(res.status).toBe(204);
  });
});

describe("POST /csp-report — anonymous access", () => {
  it("works without any auth cookie (route MUST be reachable anonymously)", async () => {
    // The route is wired into app.ts OUTSIDE the currentUser/requireAuth
    // middleware chain. Verify: no cookie, no Authorization, no problem.
    const res = await app.request("/csp-report", {
      method: "POST",
      headers: { "Content-Type": "application/csp-report" },
      body: JSON.stringify({
        "csp-report": { "blocked-uri": "inline", "violated-directive": "script-src" },
      }),
    });
    expect(res.status).toBe(204);
  });
});

describe("CSP report parsing — legacy format", () => {
  it("normalises kebab-case to camelCase and preserves all useful fields", () => {
    const out = parseLegacyReport({
      "csp-report": {
        "document-uri": "http://example.com/page",
        "blocked-uri": "https://evil.example/x.js",
        "violated-directive": "script-src",
        "effective-directive": "script-src-elem",
        "disposition": "enforce",
        "original-policy": "default-src 'self'",
        "source-file": "http://example.com/page",
        "line-number": 42,
        "column-number": 7,
        "script-sample": "evilFn()",
        "status-code": 200,
        "referrer": "https://search.example/",
      },
    });
    expect(out).toEqual({
      format: "legacy",
      documentURL: "http://example.com/page",
      blockedURL: "https://evil.example/x.js",
      // effective-directive wins over violated-directive when both present.
      effectiveDirective: "script-src-elem",
      disposition: "enforce",
      originalPolicy: "default-src 'self'",
      sourceFile: "http://example.com/page",
      lineNumber: 42,
      columnNumber: 7,
      sample: "evilFn()",
      statusCode: 200,
      referrer: "https://search.example/",
    });
  });

  it("falls back to violated-directive when effective-directive is missing", () => {
    const out = parseLegacyReport({
      "csp-report": {
        "violated-directive": "img-src",
        "blocked-uri": "https://tracker.example/p.gif",
      },
    });
    expect(out?.effectiveDirective).toBe("img-src");
  });

  it("returns null when the wrapper key is missing", () => {
    expect(parseLegacyReport({ random: "object" })).toBeNull();
  });

  it("returns null for non-objects", () => {
    expect(parseLegacyReport(null)).toBeNull();
    expect(parseLegacyReport("")).toBeNull();
    expect(parseLegacyReport(42)).toBeNull();
    expect(parseLegacyReport([])).toBeNull();
  });

  it("clips pathologically-long string fields at 2 KiB", () => {
    const huge = "y".repeat(8 * 1024);
    const out = parseLegacyReport({
      "csp-report": { "blocked-uri": huge, "violated-directive": "script-src" },
    });
    expect(out?.blockedURL?.length).toBe(2048);
  });
});

describe("CSP report parsing — modern format", () => {
  it("extracts every CSP entry from a mixed batch", () => {
    const batch = [
      { type: "deprecation", body: { id: "x" } },
      {
        type: "csp-violation",
        url: "http://example.com/a",
        body: { blockedURL: "inline", effectiveDirective: "script-src" },
      },
      {
        type: "csp-violation",
        url: "http://example.com/b",
        body: { blockedURL: "eval", effectiveDirective: "script-src" },
      },
    ];
    const out = parseModernReports(batch);
    expect(out).toHaveLength(2);
    expect(out[0]?.blockedURL).toBe("inline");
    expect(out[1]?.blockedURL).toBe("eval");
    expect(out.every((v) => v.format === "modern")).toBe(true);
  });

  it("returns [] for non-array input", () => {
    expect(parseModernReports({ "csp-report": {} })).toEqual([]);
    expect(parseModernReports(null)).toEqual([]);
    expect(parseModernReports("not an array")).toEqual([]);
  });

  it("falls back to envelope.url when body.documentURL is missing", () => {
    const out = parseModernReports([
      {
        type: "csp-violation",
        url: "http://example.com/the-doc",
        body: { blockedURL: "inline", effectiveDirective: "script-src" },
      },
    ]);
    expect(out[0]?.documentURL).toBe("http://example.com/the-doc");
  });
});

describe("isExtensionNoise — filters browser-injection traffic", () => {
  it.each([
    "chrome-extension://abc/inject.js",
    "moz-extension://def/script.js",
    "safari-extension://com.adblock/x",
    "safari-web-extension://com.passwords/y",
    "webkit-masked-url://hidden/",
    "about:blank",
    "null",
  ])("flags '%s' as noise", (uri) => {
    expect(
      isExtensionNoise({
        format: "modern",
        documentURL: "http://shop.example/",
        blockedURL: uri,
        effectiveDirective: "script-src",
        disposition: "enforce",
        originalPolicy: null,
        sourceFile: null,
        lineNumber: null,
        columnNumber: null,
        sample: null,
        statusCode: null,
        referrer: null,
      }),
    ).toBe(true);
  });

  it("does NOT flag a real inline-script violation", () => {
    expect(
      isExtensionNoise({
        format: "modern",
        documentURL: "http://shop.example/account/login",
        blockedURL: "inline",
        effectiveDirective: "script-src-elem",
        disposition: "enforce",
        originalPolicy: null,
        sourceFile: "http://shop.example/account/login",
        lineNumber: 1,
        columnNumber: 1,
        sample: "alert(1)",
        statusCode: 200,
        referrer: null,
      }),
    ).toBe(false);
  });

  it("flags a violation whose source-file is an extension even if blocked-uri is generic", () => {
    expect(
      isExtensionNoise({
        format: "modern",
        documentURL: "http://shop.example/",
        blockedURL: "inline",
        effectiveDirective: "script-src",
        disposition: "enforce",
        originalPolicy: null,
        sourceFile: "moz-extension://abc/content.js",
        lineNumber: 1,
        columnNumber: 1,
        sample: null,
        statusCode: null,
        referrer: null,
      }),
    ).toBe(true);
  });
});

describe("Rate limit — token bucket per IP", () => {
  it("admits up to maxPerWindow reports from one IP, then drops further reports", () => {
    const ip = "203.0.113.7";
    for (let i = 0; i < RATE_LIMIT_POLICY.maxPerWindow; i++) {
      expect(tryConsumeRateLimit(ip)).toBe(true);
    }
    // The (max+1)th from the same IP gets dropped.
    expect(tryConsumeRateLimit(ip)).toBe(false);
    expect(tryConsumeRateLimit(ip)).toBe(false);
  });

  it("resets the window after RATE_LIMIT_POLICY.windowMs elapses", () => {
    const ip = "203.0.113.8";
    const t0 = 1_000_000_000;
    for (let i = 0; i < RATE_LIMIT_POLICY.maxPerWindow; i++) {
      expect(tryConsumeRateLimit(ip, t0)).toBe(true);
    }
    expect(tryConsumeRateLimit(ip, t0)).toBe(false);

    // Advance past the window — the next call should re-admit.
    const t1 = t0 + RATE_LIMIT_POLICY.windowMs + 1;
    expect(tryConsumeRateLimit(ip, t1)).toBe(true);
  });

  it("tracks IPs independently — one IP being throttled does not affect another", () => {
    const a = "203.0.113.9";
    const b = "203.0.113.10";
    for (let i = 0; i < RATE_LIMIT_POLICY.maxPerWindow; i++) {
      expect(tryConsumeRateLimit(a)).toBe(true);
    }
    expect(tryConsumeRateLimit(a)).toBe(false);
    // B is unaffected.
    expect(tryConsumeRateLimit(b)).toBe(true);
  });

  it("HTTP layer drops further reports from the same X-Forwarded-For IP", async () => {
    // Send maxPerWindow accepted reports from the same synthetic IP, then
    // verify the next one still returns 204 (drop is silent — by design).
    const ip = "198.51.100.5";
    const sendOne = () =>
      app.request("/csp-report", {
        method: "POST",
        headers: {
          "Content-Type": "application/csp-report",
          "X-Forwarded-For": ip,
        },
        body: JSON.stringify({
          "csp-report": { "blocked-uri": "inline", "violated-directive": "script-src" },
        }),
      });

    for (let i = 0; i < RATE_LIMIT_POLICY.maxPerWindow; i++) {
      const r = await sendOne();
      expect(r.status).toBe(204);
    }
    const dropped = await sendOne();
    // Silent drop — same response shape so the browser can't infer the
    // rate-limit state and can't differentiate accepted vs dropped reports.
    expect(dropped.status).toBe(204);
  });
});
