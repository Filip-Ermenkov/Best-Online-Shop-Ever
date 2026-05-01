import type { Context } from "hono";
import { badRequest } from "./errors.js";

/**
 * Shared validation hook for `OpenAPIHono`.
 *
 * Why this lives in its own module:
 *
 *   `defaultHook` is a constructor option on `OpenAPIHono`. Mounting a
 *   sub-router via `app.route(prefix, subRouter)` does NOT inherit the
 *   parent's constructor options — every `OpenAPIHono` instance has its
 *   own validation pipeline. That means `routes/products.ts` needs the
 *   same hook the root `app.ts` uses, or its 400 responses fall through
 *   to `@hono/zod-validator`'s stock `{success: false, error: {...}}`
 *   shape and our RFC 9457 contract gets violated.
 *
 *   Wiring this from one place keeps the two in lock-step.
 */
export const validationHook = (
  result: { success: true; data: unknown } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } },
  c: Context,
) => {
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({
      path: i.path.map(String).join(".") || "(root)",
      message: i.message,
    }));
    const problem = badRequest("Request validation failed", issues).problem;
    return c.json(problem, 400, {
      "Content-Type": "application/problem+json; charset=utf-8",
    });
  }
  return undefined;
};
