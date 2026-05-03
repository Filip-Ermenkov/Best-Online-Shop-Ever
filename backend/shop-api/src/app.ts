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
import { currentUser, type AuthVariables } from "./middleware/auth.js";
import { authRoutes } from "./routes/auth.js";
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
} & AuthVariables;

/**
 * Compose the Hono app.
 */
export function buildApp() {
  const env = parseEnv();

  const app = new OpenAPIHono<{ Variables: AppVariables }>({
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
      // Origin echo from the allowlist. Returning `null` from the function
      // makes Hono drop the Access-Control-Allow-Origin header entirely,
      // which is exactly what we want for cross-origin rejections.
      origin: (origin) => {
        if (!origin) return undefined;
        return env.CORS_ORIGINS.includes(origin) ? origin : null;
      },
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization", "If-None-Match", "X-Request-Id"],
      exposeHeaders: ["ETag", "X-Request-Id"],
      // Required for the browser to send & receive the session cookie on
      // cross-origin requests. Combined with the explicit-origin function
      // above (no wildcard) per the CORS-with-credentials rules. The
      // frontend MUST also pass `credentials: "include"` on its fetches.
      credentials: true,
      maxAge: 600,
    }),
  );

  app.use("/products/*", etag());
  app.use("/products", etag());
  app.use("/categories/*", etag());
  app.use("/categories", etag());

  app.use("/products/*", currentUser);
  app.use("/products", currentUser);
  app.use("/categories/*", currentUser);
  app.use("/categories", currentUser);
  app.use("/auth/*", currentUser);

  app.get("/health", (c) => c.json({ ok: true }));

  app.route("/products", productsRoutes);
  app.route("/categories", categoriesRoutes);
  app.route("/auth", authRoutes);

  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "shop-api",
      version: "0.1.0",
      description: "Public read API for the Bulgarian online shop catalog.",
    },
    servers: [{ url: "http://localhost:3001", description: "Local dev" }],
  });

  app.onError((err, c) => {
    const log = c.get("logger") ?? baseLogger;

    if (err instanceof ApiError) {
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
