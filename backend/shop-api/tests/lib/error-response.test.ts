import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { frameworkProblem, statusTitle } from "../../src/lib/error-response.js";
import { internal } from "../../src/lib/errors.js";

/**
 * Pure-unit coverage for the framework-error classifier — no DB, no app boot,
 * mirroring tests/lib/seo.ts and the @shop/auth crypto suites. The end-to-end
 * proof that a malformed body actually reaches onError and returns 400 (not 500)
 * lives in tests/routes/error-handling.ts.
 *
 * The decision this guards: a framework error that carries a real HTTP status
 * (above all the HTTPException Hono throws on a JSON parse failure) must be
 * mapped to that status, never silently promoted to a 500 — both for client
 * correctness (RFC 9110 §15.6) and because the availability SLI counts only
 * `status >= 500` (§15 items 24/25), so a mislabelled client error would burn
 * the server error budget.
 */
describe("frameworkProblem", () => {
  it("maps Hono's malformed-JSON HTTPException to a 400 /problems/malformed-json", () => {
    // This is the exact error Hono core's body validator throws when JSON.parse
    // fails on the request body (verified against hono ^4.12.26).
    const err = new HTTPException(400, {
      message: "Malformed JSON in request body",
    });
    const problem = frameworkProblem(err);
    expect(problem).not.toBeNull();
    expect(problem).toMatchObject({
      type: "/problems/malformed-json",
      title: "Malformed JSON",
      status: 400,
    });
    // The detail must never reflect the offending body back to the caller.
    expect(problem?.detail).toBe("The request body could not be parsed as JSON.");
  });

  it("maps a raw SyntaxError (native Request.json()) to the same 400", () => {
    // Build the SyntaxError the way JSON.parse actually produces it.
    let syntaxErr: unknown;
    try {
      JSON.parse("{ not json");
    } catch (e) {
      syntaxErr = e;
    }
    expect(syntaxErr).toBeInstanceOf(SyntaxError);
    const problem = frameworkProblem(syntaxErr);
    expect(problem).toMatchObject({
      type: "/problems/malformed-json",
      status: 400,
    });
    // Crucially, the parser's message ("Unexpected token …") is NOT surfaced.
    expect(problem?.detail).not.toContain("not json");
  });

  it("honours the real status of any other framework HTTPException", () => {
    // e.g. a tripped bodyLimit → 413 with a message.
    const err = new HTTPException(413, { message: "Body too large" });
    expect(frameworkProblem(err)).toMatchObject({
      type: "about:blank",
      title: "Body too large",
      status: 413,
    });
  });

  it("supplies a reason-phrase title when the HTTPException message is empty", () => {
    // `new HTTPException(503)` carries an empty message.
    const err = new HTTPException(503);
    expect(frameworkProblem(err)).toMatchObject({
      type: "about:blank",
      title: "Service Unavailable",
      status: 503,
    });
  });

  it("keeps a 5xx framework error a 5xx (does not mask it as a client error)", () => {
    const problem = frameworkProblem(new HTTPException(502));
    expect(problem?.status).toBe(502);
  });

  it("returns null for our own ApiError so onError maps its rich Problem first", () => {
    // ApiError extends HTTPException; flattening it here would drop its Problem.
    expect(frameworkProblem(internal("boom"))).toBeNull();
  });

  it("returns null for a ZodError (handled by its own onError branch)", () => {
    const zErr = new ZodError([]);
    expect(frameworkProblem(zErr)).toBeNull();
  });

  it("returns null for an unknown Error so it still becomes a 500", () => {
    expect(frameworkProblem(new Error("kaboom"))).toBeNull();
    expect(frameworkProblem("a thrown string")).toBeNull();
    expect(frameworkProblem(undefined)).toBeNull();
  });
});

describe("statusTitle", () => {
  it("returns RFC 9110 reason phrases for known statuses", () => {
    expect(statusTitle(400)).toBe("Bad Request");
    expect(statusTitle(413)).toBe("Content Too Large");
    expect(statusTitle(429)).toBe("Too Many Requests");
    expect(statusTitle(503)).toBe("Service Unavailable");
  });

  it("falls back to a generic label for an unmapped status", () => {
    expect(statusTitle(418)).toBe("HTTP 418");
  });
});
