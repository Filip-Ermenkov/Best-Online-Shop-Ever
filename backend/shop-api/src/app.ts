import { httpInstrumentationMiddleware } from "@hono/otel";
import { OpenAPIHono } from "@hono/zod-openapi";
import { trace } from "@opentelemetry/api";
import { cors } from "hono/cors";
import { etag } from "hono/etag";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Logger } from "pino";
import { ZodError } from "zod";
import { parseEnv } from "./lib/env.js";
import { ApiError, badRequest, internal, type Problem } from "./lib/errors.js";
import { logger as baseLogger, requestLogger } from "./lib/logger.js";
import { isTracingEnabled } from "./lib/tracing.js";
import { validationHook } from "./lib/validation-hook.js";
import { currentUser, type AuthVariables } from "./middleware/auth.js";
import { adminAuthRoutes } from "./routes/admin/auth.js";
import { adminCategoriesRoutes } from "./routes/admin/categories.js";
import { adminOrdersRoutes } from "./routes/admin/orders.js";
import { addressesRoutes } from "./routes/addresses.js";
import { authRoutes } from "./routes/auth.js";
import { cartRoutes } from "./routes/cart.js";
import { categoriesRoutes } from "./routes/categories.js";
import { consentRoutes } from "./routes/consent.js";
import { cspRoutes } from "./routes/csp.js";
import { guestRoutes, trackRoutes } from "./routes/guest.js";
import { ordersRoutes } from "./routes/orders.js";
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

  /**
   * Distributed tracing (roadmap item 18). Outermost middleware so the
   * per-request span wraps every other middleware and the handler, and so the
   * span is active on the context when the logging middleware below — and the
   * Pino mixin — read it. Added ONLY when ENABLE_TRACING=true; the no-op default
   * keeps the request path untouched. The tracer provider is started in the
   * Lambda handler / dev server entry (see lib/tracing.ts → initTracing()).
   */
  if (isTracingEnabled()) {
    app.use(
      "*",
      httpInstrumentationMiddleware({
        serviceName: "shop-api",
        serviceVersion: "0.1.0",
      }),
    );
  }

  app.use("*", requestId());

  /**
   * Security headers for every API response. This Hono middleware is a JSON-
   * API counterpart to the strict CSP shipped on the Next.js frontend.
   *
   * The CSP here is the strictest possible: `default-src 'none'` — nothing
   * loads, no frames, no scripts, no images. That's correct for a JSON
   * endpoint, which has no business rendering HTML. The header is
   * defence-in-depth: if a content-type-confusion attack ever fooled a
   * browser into rendering a Problem+JSON response as HTML, this policy
   * blocks everything inline.
   *
   * `crossOriginResourcePolicy: same-site` allows the legitimate cross-
   * subdomain fetch from shop.duda1.bg → shop-api.duda1.bg (same
   * registrable domain) but blocks attempts by unrelated origins to
   * `<img src>` or `<script src>` an API response. CORS allow-listing in
   * the cors() middleware below remains the authoritative gate for the
   * actual fetch path; CORP is defence-in-depth against embed-style loads.
   *
   * `xFrameOptions` and `frameAncestors` both forbid embedding — again
   * meaningless for JSON, useful only if a browser somehow renders the
   * response as HTML.
   *
   * Hono docs: https://hono.dev/docs/middleware/builtin/secure-headers
   */
  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: "same-origin",
      crossOriginResourcePolicy: "same-site",
      referrerPolicy: "no-referrer",
      strictTransportSecurity:
        "max-age=63072000; includeSubDomains; preload",
      xContentTypeOptions: "nosniff",
      xFrameOptions: "DENY",
      // The API serves no user-controlled HTML, so xXssProtection (a legacy
      // header anyway) and xDnsPrefetchControl don't earn their bytes. We
      // explicitly turn them off so Hono doesn't ship surprising defaults.
      xDnsPrefetchControl: false,
      xXssProtection: false,
      // Permissions-Policy on a JSON API is mostly aspirational, but it's
      // free defence-in-depth — if a browser ever evaluated this response
      // as HTML, none of these features could be enabled.
      permissionsPolicy: {
        camera: [],
        microphone: [],
        geolocation: [],
        payment: [],
        usb: [],
        accelerometer: [],
        gyroscope: [],
        magnetometer: [],
        fullscreen: [],
      },
    }),
  );

  app.use("*", async (c, next) => {
    const id = c.get("requestId");
    // Stamp the request id onto the active span so X-Request-Id (returned to the
    // client and present in every log line) is queryable in the trace too — the
    // three correlation handles become one. No-op when tracing is off.
    trace.getActiveSpan()?.setAttribute("app.request_id", id);
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
      // `method` + `path` make request_end a SELF-CONTAINED completion event:
      // the SLO SLIs (availability, order-placement success, latency) are
      // CloudWatch Logs metric filters over this one line, so a filter never has
      // to join request_start↔request_end by requestId. See infra/slos.yaml +
      // infra/slo.tf (roadmap items 24/25). Mirrors request_start's fields.
      // `path` is the pathname only (no query string), so reset/verify tokens
      // never reach the log — same safety the existing request_start line relies
      // on. NB: request_end is INFO level; the metric filters need the deployed
      // Lambda at log_level=info (a slo.tf precondition enforces it).
      log.info(
        {
          method: c.req.method,
          path: c.req.path,
          status: c.res.status,
          durationMs: ms,
        },
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
      // `Idempotency-Key` is a non-simple header (not in CORS's safelist),
      // so the browser issues an OPTIONS preflight on any request that
      // sets it, and the server must advertise it here explicitly. Required
      // by POST /orders. CORS header-name matching is case-insensitive per
      // RFC 9110 §5.1, but Hono's middleware echoes the exact string we
      // provide — we use the canonical PascalCase the wider ecosystem
      // (Stripe, MDN, the IETF draft) writes it as.
      allowHeaders: ["Content-Type", "Authorization", "If-None-Match", "X-Request-Id", "Idempotency-Key"],
      exposeHeaders: ["ETag", "X-Request-Id"],
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
  app.use("/cart/*", currentUser);
  app.use("/cart", currentUser);
  app.use("/orders/*", currentUser);
  app.use("/orders", currentUser);
  app.use("/addresses/*", currentUser);
  app.use("/addresses", currentUser);
  // Admin auth surface. currentUser resolves the cookie so GET /admin/auth/me
  // can gate on role; the login / mfa / enrolment routes are pre-session and
  // simply see no user. The mandatory-TOTP flow lives in routes/admin/auth.ts.
  app.use("/admin/auth/*", currentUser);
  // Admin order management — every route requireAdmin-gated inside the router.
  app.use("/admin/orders/*", currentUser);
  app.use("/admin/orders", currentUser);
  // Admin category management — every route requireAdmin-gated inside the router.
  app.use("/admin/categories/*", currentUser);
  app.use("/admin/categories", currentUser);

  app.get("/health", (c) => c.json({ ok: true }));

  app.route("/products", productsRoutes);
  app.route("/categories", categoriesRoutes);
  app.route("/auth", authRoutes);
  app.route("/admin/auth", adminAuthRoutes);
  app.route("/admin/orders", adminOrdersRoutes);
  app.route("/admin/categories", adminCategoriesRoutes);
  app.route("/cart", cartRoutes);
  app.route("/orders", ordersRoutes);
  app.route("/addresses", addressesRoutes);
  // Guest checkout + order tracking — anonymous by design (the spec's "Гост"
  // role). No currentUser middleware: the only credential these routes accept
  // is the order's capability token. See routes/guest.ts.
  app.route("/guest", guestRoutes);
  app.route("/track", trackRoutes);
  // Cookie-consent receipts — anonymous, no currentUser middleware
  // (intentional): consent is collected from guests too and is independent of
  // any login. Keyed on an opaque visitor cookie; see routes/consent.ts.
  app.route("/consent", consentRoutes);
  // CSP violation reports — anonymous, no currentUser middleware (intentional).
  // Always returns 204 No Content; see backend/shop-api/src/routes/csp.ts for
  // the full design rationale.
  app.route("/csp-report", cspRoutes);

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
    // Pino's level is "silent" in the test runner, which would otherwise
    // swallow the exception. Mirror to stderr in non-production so failing
    // tests / `npm run dev` interactive sessions surface the root cause.
    // Production logs the same payload via pino on Lambda — no double-write.
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.error("[unhandled_error]", err);
    }
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

// AppType is the Hono RPC lynchpin; see src/types.ts for the consumer story.
export type AppType = ReturnType<typeof buildApp>;
