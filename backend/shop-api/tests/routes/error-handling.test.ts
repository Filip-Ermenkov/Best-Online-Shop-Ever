import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import type { Problem } from "../../src/lib/errors.js";

/**
 * Cross-cutting coverage for the global onError contract (app.ts) — specifically
 * that FRAMEWORK-level errors are mapped to the right HTTP status instead of a
 * blanket 500.
 *
 * The load-bearing case is a malformed JSON request body: Hono's body validator
 * throws an HTTPException(400) BEFORE our Zod defaultHook runs, so it is neither
 * an ApiError nor a ZodError. Before this slice it fell through to the 500 path —
 * telling the client the server had failed and burning the availability SLI's
 * error budget (5xx ÷ total; §15 items 24/25) on a client mistake.
 *
 * We exercise it through a real route (`POST /consent`, anonymous, `.strict()`
 * JSON body). The malformed body short-circuits in the validator middleware
 * before any DB access, so these cases need no seed. The pure decision table is
 * unit-tested in tests/lib/error-response.ts.
 */
let app: ReturnType<typeof buildApp>;

beforeAll(() => {
  app = buildApp();
});

describe("onError — framework error mapping", () => {
  it("returns 400 /problems/malformed-json for an unparseable JSON body (not 500)", async () => {
    const res = await app.request("/consent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ this is not valid json ",
    });

    expect(res.status).toBe(400);
    expect(res.status).not.toBe(500);
    expect(res.headers.get("content-type")).toContain("application/problem+json");

    const body = (await res.json()) as Problem;
    expect(body).toMatchObject({
      type: "/problems/malformed-json",
      title: "Malformed JSON",
      status: 400,
    });
    // The occurrence is tagged with the request id (the project's RFC 9457
    // `instance` convention), and the offending body is never reflected back.
    expect(typeof body.instance).toBe("string");
    expect(JSON.stringify(body)).not.toContain("not valid json");
  });

  it("still returns the validation 400 (not malformed-json) for parseable-but-invalid bodies", async () => {
    // Valid JSON that fails the schema must keep flowing through the existing
    // ZodError/validation branch — this proves the new branch didn't swallow it.
    const res = await app.request("/consent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ definitelyNotAField: true }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Problem;
    expect(body.type).not.toBe("/problems/malformed-json");
    expect(body.status).toBe(400);
    // The validation path attaches structured field errors; malformed-json does not.
    expect(Array.isArray(body.errors)).toBe(true);
  });

  it("still returns a 404 Problem for an unknown route", async () => {
    const res = await app.request("/no/such/route");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const body = (await res.json()) as Problem;
    expect(body.status).toBe(404);
  });
});
