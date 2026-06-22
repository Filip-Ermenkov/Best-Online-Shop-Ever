import { HTTPException } from "hono/http-exception";
import { ApiError, malformedJson, type Problem } from "./errors.js";

/**
 * RFC 9110 reason phrases for the handful of statuses the framework can throw
 * as a bare `HTTPException` with no message. Intentionally small — extend it
 * only when a new framework-thrown status actually appears. Falls back to a
 * generic `HTTP <status>` label so the response is always well-formed.
 */
const STATUS_TITLES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  408: "Request Timeout",
  409: "Conflict",
  413: "Content Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

export function statusTitle(status: number): string {
  return STATUS_TITLES[status] ?? `HTTP ${status}`;
}

/**
 * Map a FRAMEWORK-level thrown value to an RFC 9457 Problem, or return `null`
 * when it isn't one we specially classify (the caller then falls back to its
 * generic 500 path).
 *
 * Why this exists as its own pure function:
 *
 *   The global `onError` in `app.ts` already maps our own `ApiError` and Zod's
 *   `ZodError` to Problem responses, then treats EVERYTHING else as a 500. But
 *   the framework itself throws typed errors that carry a real HTTP status —
 *   most importantly Hono's request-body validator throws
 *   `HTTPException(400, "Malformed JSON in request body")` when `JSON.parse`
 *   fails, and it does so BEFORE our Zod `defaultHook` runs, so it never becomes
 *   a `ZodError`. Without this branch that 400 fell through to the 500 path:
 *   a client sending a malformed body was told the SERVER had failed, and the
 *   availability SLI (which counts `status >= 500`; §15 items 24/25) burned its
 *   error budget on a client mistake. RFC 9110 §15.6 is explicit that a 5xx
 *   says "retry the identical request and it may succeed" — false for bad JSON.
 *
 *   Keeping the classification pure (no Context, no logger, no DB) means the
 *   whole decision table is unit-tested without booting the app — the same
 *   convention the rest of `lib/*.ts` follows.
 *
 * NB: our `ApiError extends HTTPException`, so this function explicitly excludes
 * it — an `ApiError` carries a rich Problem that `onError` maps first and must
 * not be flattened into the generic shape here. The guard makes the function
 * correct even if the call order in `onError` ever changes.
 */
export function frameworkProblem(err: unknown): Problem | null {
  if (err instanceof HTTPException && !(err instanceof ApiError)) {
    // Hono core throws this exact message from its body validator on a JSON
    // parse failure (see `hono/validator`). Give it a first-class Problem type
    // instead of echoing the bare framework string.
    if (err.status === 400 && err.message === "Malformed JSON in request body") {
      return malformedJson().problem;
    }
    // Any other framework HTTPException (a tripped `bodyLimit` → 413, etc.):
    // honour its real status. RFC 9457 §3.1 — with `type: about:blank`, `title`
    // SHOULD be the status code's reason phrase; HTTPException's message can be
    // empty (e.g. `new HTTPException(503)`), so supply the phrase ourselves.
    return {
      type: "about:blank",
      title: err.message || statusTitle(err.status),
      status: err.status,
    };
  }

  // A raw `SyntaxError` reaches `onError` only if a route parses the body
  // directly with `c.req.json()` — the native `Request.json()` throws a
  // `SyntaxError`, not an `HTTPException`. No route does that today (every body
  // goes through the `@hono/zod-openapi` validator above), so this is
  // defence-in-depth: any future direct parse degrades to the same clean 400
  // rather than a 500. We deliberately do NOT surface `err.message` — it can
  // quote the offending token out of the (possibly PII-bearing) request body.
  if (err instanceof SyntaxError) {
    return malformedJson().problem;
  }

  return null;
}
