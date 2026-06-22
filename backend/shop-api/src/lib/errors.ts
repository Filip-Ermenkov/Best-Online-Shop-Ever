import type { ContentfulStatusCode } from "hono/utils/http-status";
import { HTTPException } from "hono/http-exception";
// `z` re-exported from @hono/zod-openapi has the `.openapi()` extension wired
// on every schema. Importing the bare zod here would compile but `ProblemSchema
// .openapi("Problem")` would not register a component in the spec.
import { z } from "@hono/zod-openapi";

/**
 * RFC 9457 "Problem Details for HTTP APIs" response body.
 *   - type:     URI identifying the problem class (e.g. /problems/not-found).
 *   - title:    short human-readable summary.
 *   - status:   HTTP status code (mirrored from response).
 *   - detail:   instance-specific human-readable explanation.
 *   - instance: optional URI for THIS occurrence (we use request id).
 *   - errors:   optional structured field-level errors for validation failures.
 *
 * Choosing RFC 9457 over an ad-hoc shape gives us:
 *   - one consistent error contract across every endpoint,
 *   - room for additive extensions without breaking clients,
 *   - clear semantics for tools and proxies (Content-Type:
 *     application/problem+json signals errors to clients/CDN).
 */
export const ProblemSchema = z
  .object({
    type: z.string().default("about:blank"),
    title: z.string(),
    status: z.number().int(),
    detail: z.string().optional(),
    instance: z.string().optional(),
    errors: z
      .array(
        z.object({
          path: z.string(),
          message: z.string(),
        }),
      )
      .optional(),
  })
  .openapi("Problem");

export type Problem = z.infer<typeof ProblemSchema>;

const PROBLEM_CONTENT_TYPE = "application/problem+json; charset=utf-8";

/**
 * Throw this from a route to signal a known error. Hono's onError handler
 * (configured in app.ts) turns it into a Problem response.
 */
export class ApiError extends HTTPException {
  problem: Problem;

  constructor(problem: Problem) {
    super(problem.status as ContentfulStatusCode, { message: problem.title });
    this.problem = problem;
  }
}

export function notFound(detail: string, type = "about:blank"): ApiError {
  return new ApiError({
    type,
    title: "Not Found",
    status: 404,
    detail,
  });
}

export function badRequest(detail: string, errors?: Problem["errors"]): ApiError {
  return new ApiError({
    type: "about:blank",
    title: "Bad Request",
    status: 400,
    detail,
    errors,
  });
}

/**
 * The request body could not be parsed as JSON (a SYNTAX failure, distinct from
 * a schema-validation failure — RFC 9110 §15.5.1 / RFC 9457). 400, never 500: a
 * 5xx tells the client the fault is the server's and an identical retry might
 * succeed, which is wrong here, and a 5xx would also burn the availability SLI's
 * error budget (5xx ÷ total; §15 items 24/25) on a client mistake.
 *
 * The detail is deliberately a FIXED string — it never reflects the offending
 * token or any slice of the (possibly PII-bearing) request body back to the
 * caller.
 */
export function malformedJson(
  detail = "The request body could not be parsed as JSON.",
): ApiError {
  return new ApiError({
    type: "/problems/malformed-json",
    title: "Malformed JSON",
    status: 400,
    detail,
  });
}

export function internal(detail = "Internal Server Error"): ApiError {
  return new ApiError({
    type: "about:blank",
    title: "Internal Server Error",
    status: 500,
    detail,
  });
}

export const PROBLEM_HEADERS = { "Content-Type": PROBLEM_CONTENT_TYPE };
