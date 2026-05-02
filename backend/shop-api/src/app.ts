import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { etag } from "hono/etag";
import { requestId } from "hono/request-id";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Logger } from "pino";
import { ZodError } from "zod";
import { parseEnv } from "./lib/env.js";
import { ApiError, badRequest, internal, type Problem } from "./lib/errors.js";
import { logger as baseLogger, requestLogger } from "./lib/logger.js";
import { validationHook } from "./lib/validation-hook.js";
import { categoriesRoutes } from "./routes/categories.js";
import { productsRoutes } from "./routes/products.js";

/**
 * Variables we attach to every Hono Context. Declared as a type parameter on
 * OpenAPIHono so `c.get("logger")` and `c.get("requestId")` are type-safe
 * everywhere downstream (routes, error handler, notFound handler).
 */
type AppVariables = {
  requestId: string;
  logger: Logger;
};

/**
 * Compose the Hono app.
 *
 * Order of middleware matters:
 *   1. requestId    — assigns/propagates X-Request-Id; everything downstream uses it.
 *   2. logger       — start/finish access log with the request id.
 *   3. cors         — runs early so preflights short-circuit.
 *   4. etag         — sits around the route handlers so it can compute the
 *                     hash from the rendered body and short-circuit with 304.
 *
 * Returns OpenAPIHono so the caller can also register `app.doc(...)` if
 * desired (we expose /openapi.json from buildApp directly).
 *
 * `app` is exported as the AppType for Hono RPC clients (see types.ts).
 */
export function buildApp() {
  const env = parseEnv();

  const app = new OpenAPIHono<{ Variables: AppVariables }>({
    // Hand zod validation errors back as RFC 9457 problems instead of Hono's
    // default. Note that this option is per-OpenAPIHono-instance — the same
    // hook is also passed to every sub-router (see routes/products.ts).
    defaultHook: validationHook,
  });

  app.use("*", requestId());

  app.use("*", async (c, next) => {
    const id = c.get("requestId");
    const log = requestLogger(id);
    c.set("logger", log);
    const start = Date.now();
    log.info(
      { method: c.req.method, path: c.req.path, ua: c.req.header("user-agent") },
      "request_start",
    );
    try {
      await next();
    } finally {
      const ms = Date.now() - start;
      log.info(
        { status: c.res.status, durationMs: ms },
        "request_end",
      );
    }
  });

  app.use(
    "*",
    cors({
      origin: (origin) => {
        if (!origin) return undefined;
        return env.CORS_ORIGINS.includes(origin) ? origin : null;
      },
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "If-None-Match", "X-Request-Id"],
      exposeHeaders: ["ETag", "X-Request-Id"],
      maxAge: 600,
    }),
  );

  // Built-in ETag middleware: computes a strong hash from the response body
  // and turns matching requests into 304s automatically.
  app.use("/products/*", etag());
  app.use("/products", etag());
  app.use("/categories/*", etag());
  app.use("/categories", etag());

  // Health probe — used by the Lambda Function URL warmup, ALB target group,
  // and "is the local dev server actually up" curls. Deliberately trivial and
  // un-cached.
  app.get("/health", (c) => c.json({ ok: true }));

  // Mount feature routes.
  app.route("/products", productsRoutes);
  app.route("/categories", categoriesRoutes);

  // OpenAPI 3.1 document at /openapi.json. Generated from the typed routes
  // above — single source of truth for the API contract.
  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "shop-api",
      version: "0.1.0",
      description: "Public read API for the Bulgarian online shop catalog.",
    },
    servers: [{ url: "http://localhost:3001", description: "Local dev" }],
  });

  // Global error handler: turn any uncaught exception into an RFC 9457 Problem.
  app.onError((err, c) => {
    const log = c.get("logger") ?? baseLogger;

    if (err instanceof ApiError) {
      // Known, intentional error path.
      const problem: Problem = {
        ...err.problem,
        instance: c.get("requestId"),
      };
      if (problem.status >= 500) {
        log.error({ err, problem }, "api_error_5xx");
      } else {
        log.warn({ problem }, "api_error_4xx");
      }
      return c.json(problem, problem.status as ContentfulStatusCode, {
        "Content-Type": "application/problem+json; charset=utf-8",
      });
    }

    if (err instanceof ZodError) {
      // Zod parse error escaped a route — treat as a validation 400.
      const issues = err.issues.map((i) => ({
        path: i.path.map(String).join(".") || "(root)",
        message: i.message,
      }));
      const problem = badRequest("Request validation failed", issues).problem;
      log.warn({ problem }, "api_error_4xx");
      return c.json(
        { ...problem, instance: c.get("requestId") },
        400,
        { "Content-Type": "application/problem+json; charset=utf-8" },
      );
    }

    // Unexpected. Never leak `err.message` — clients see a generic detail,
    // operators see the full stack in CloudWatch.
    log.error({ err }, "unhandled_error");
    const problem: Problem = {
      ...internal().problem,
      instance: c.get("requestId"),
    };
    return c.json(problem, 500, {
      "Content-Type": "application/problem+json; charset=utf-8",
    });
  });

  app.notFound((c) => {
    const problem: Problem = {
      type: "about:blank",
      title: "Not Found",
      status: 404,
      detail: `No route for ${c.req.method} ${c.req.path}`,
      instance: c.get("requestId"),
    };
    return c.json(problem, 404, {
      "Content-Type": "application/problem+json; charset=utf-8",
    });
  });

  return app;
}

export type AppType = ReturnType<typeof buildApp>;
