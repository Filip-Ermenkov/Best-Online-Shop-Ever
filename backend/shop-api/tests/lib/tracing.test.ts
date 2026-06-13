import { context, propagation, trace } from "@opentelemetry/api";
import { AWSXRayIdGenerator } from "@opentelemetry/id-generator-aws-xray";
import { AWSXRayPropagator } from "@opentelemetry/propagator-aws-xray";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { httpInstrumentationMiddleware } from "@hono/otel";
import { Hono } from "hono";
import pino from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { _resetEnvForTests } from "../../src/lib/env.js";
import { traceContextMixin } from "../../src/lib/logger.js";
import {
  _shutdownTracingForTests,
  flushTracing,
  initTracing,
  isTracingEnabled,
} from "../../src/lib/tracing.js";

/**
 * Distributed-tracing slice (roadmap item 18). These prove the two mechanisms
 * that live in THIS repo — the ENABLE_TRACING toggle / no-op path, and the
 * Pino log↔trace correlation — plus the `@hono/otel` request-span integration
 * end-to-end against a real in-memory tracer provider.
 *
 * We register a LOCAL provider with an InMemorySpanExporter (mirroring what
 * lib/tracing.ts builds internally) rather than driving initTracing()'s
 * enabled path, so the test never registers a second global provider and never
 * leaks tracing state into the rest of the suite. initTracing()'s real
 * provider/exporter wiring is exercised out-of-band by the standalone harness
 * and a live deploy (see infra/README.md → "Tracing runbook").
 */

const ORIGINAL = {
  ENABLE_TRACING: process.env.ENABLE_TRACING,
  OTEL_TRACES_EXPORTER: process.env.OTEL_TRACES_EXPORTER,
} as const;

const exporter = new InMemorySpanExporter();
let provider: NodeTracerProvider;

beforeAll(() => {
  provider = new NodeTracerProvider({
    idGenerator: new AWSXRayIdGenerator(),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  // Installs the global tracer provider + an AsyncLocalStorage context manager,
  // so trace.getActiveSpan() resolves inside handlers and the Pino mixin.
  provider.register({ propagator: new AWSXRayPropagator() });
});

afterEach(() => {
  exporter.reset();
  for (const key of ["ENABLE_TRACING", "OTEL_TRACES_EXPORTER"] as const) {
    if (ORIGINAL[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL[key];
  }
  _resetEnvForTests();
});

afterAll(async () => {
  await _shutdownTracingForTests();
  await provider.shutdown();
  // Reset the OpenTelemetry globals so no later test file inherits them.
  trace.disable();
  context.disable();
  propagation.disable();
});

describe("tracing feature flag", () => {
  it("isTracingEnabled reflects ENABLE_TRACING", () => {
    process.env.ENABLE_TRACING = "true";
    _resetEnvForTests();
    expect(isTracingEnabled()).toBe(true);

    process.env.ENABLE_TRACING = "false";
    _resetEnvForTests();
    expect(isTracingEnabled()).toBe(false);
  });

  it("initTracing + flushTracing are safe no-ops when disabled", async () => {
    process.env.ENABLE_TRACING = "false";
    _resetEnvForTests();
    await expect(initTracing()).resolves.toBeUndefined();
    await expect(flushTracing()).resolves.toBeUndefined();
    await _shutdownTracingForTests();
  });
});

describe("log↔trace correlation", () => {
  it("traceContextMixin is empty when no span is active", () => {
    expect(traceContextMixin()).toEqual({});
  });

  it("traceContextMixin stamps the active span's ids", () => {
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("manual");
    const out = context.with(trace.setSpan(context.active(), span), () =>
      traceContextMixin(),
    );
    span.end();

    expect(out.trace_id).toBe(span.spanContext().traceId);
    expect(out.span_id).toBe(span.spanContext().spanId);
    // X-Ray-compatible: 32 lowercase hex (the first 8 encode the epoch).
    expect(out.trace_id).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("@hono/otel request span", () => {
  it("produces one span per request and correlates the Pino log line", async () => {
    const lines: Array<Record<string, unknown>> = [];
    const log = pino(
      { level: "info", mixin: traceContextMixin },
      { write: (s: string) => void lines.push(JSON.parse(s)) },
    );

    const app = new Hono();
    app.use(
      "*",
      httpInstrumentationMiddleware({
        serviceName: "shop-api",
        serviceVersion: "0.1.0",
      }),
    );
    app.use("*", async (c, next) => {
      // Mirrors app.ts: tie X-Request-Id onto the span.
      trace.getActiveSpan()?.setAttribute("app.request_id", "req-xyz");
      log.info("request_start");
      await next();
    });
    app.get("/health", (c) => c.json({ ok: true }));

    const res = await app.request("/health");
    await provider.forceFlush();

    expect(res.status).toBe(200);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.attributes["app.request_id"]).toBe("req-xyz");
    expect(span.attributes["http.route"]).toBe("/health");

    const startLog = lines.find((l) => l["msg"] === "request_start");
    expect(startLog).toBeDefined();
    expect(startLog!["trace_id"]).toBe(span.spanContext().traceId);
    expect(startLog!["span_id"]).toBe(span.spanContext().spanId);
  });
});
