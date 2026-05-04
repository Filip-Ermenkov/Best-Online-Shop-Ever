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
 *
 * Type signature note:
 *
 *   `defaultHook` on `OpenAPIHono` is internally typed against Hono's
 *   `Hook<any, …>`, which accepts a `ZodError<unknown>`. Zod 4's
 *   `$ZodIssue.path` is `PropertyKey[]` (it can include `symbol`), while
 *   Hono's older internal definition expects `(string | number)[]`. A
 *   strictly-typed hook signature won't structurally match either side
 *   cleanly. Rather than chase the moving target across Zod / Hono
 *   versions, accept `unknown` and use a small runtime extractor — the
 *   payload shape is well-known at runtime even when the static types
 *   don't agree.
 */
export const validationHook = (result: unknown, c: Context) => {
  const r = result as {
    success: boolean;
    error?: { issues?: { path?: PropertyKey[]; message?: string }[] };
  };
  if (r.success) return undefined;

  const rawIssues = r.error?.issues ?? [];
  const issues = rawIssues.map((i) => ({
    path: (i.path ?? []).map((p) => String(p)).join(".") || "(root)",
    message: i.message ?? "Invalid value",
  }));
  const problem = badRequest("Request validation failed", issues).problem;
  return c.json(problem, 400, {
    "Content-Type": "application/problem+json; charset=utf-8",
  });
};
