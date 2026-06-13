/**
 * OpenTelemetry tracing for shop-api (roadmap item 18 — distributed tracing).
 *
 * Closes the last OWASP Top 10 2025 A09 gap (§5.3) and the NIST CSF 2.0
 * "Detect" gap (§14): every request becomes a trace, correlated to the Pino
 * logs that already exist, exportable to AWS X-Ray (via the ADOT collector
 * layer) or any OTLP backend (Grafana Tempo, Honeycomb, Datadog — the
 * backend stays a single env var, per §8.2).
 *
 * ── Design (see ARCHITECTURE.md §8.2 + §13) ────────────────────────────────
 *
 *  • Near-zero cost when off. ENABLE_TRACING defaults false; the heavy
 *    OpenTelemetry graph (SDK, exporter, instrumentations) is reached only via
 *    dynamic import() *inside* the enabled branch, so on the default path those
 *    modules are bundled but never evaluated — no provider, no exporter, no
 *    instrumentation hooks. (`@hono/otel` and `@opentelemetry/api` are the only
 *    always-loaded pieces; both are tiny, and `@opentelemetry/api` is a
 *    documented no-op until a provider registers.)
 *
 *  • Request spans come from `@hono/otel` (wired in app.ts) — instrumenting at
 *    the Hono layer, not the Node HTTP server, so it fires identically on the
 *    local node-server AND on Lambda (where Hono runs through the
 *    `hono/aws-lambda` adapter, not an HTTP listener — the stock
 *    `instrumentation-http` would never see those requests).
 *
 *  • Downstream spans come from `undici` (global fetch) instrumentation. It
 *    hooks Node's `diagnostics_channel`, so — unlike require-patching
 *    instrumentations (pg, aws-sdk) — it survives the esbuild single-file
 *    bundle and captures the calls that matter in PRODUCTION: the Neon
 *    serverless driver runs ordinary queries over an HTTPS fetch, and the HIBP
 *    breach check is a fetch too. Why not pg/aws-sdk auto-instrumentation? They
 *    patch their target module at require-time, which only works if the
 *    instrumentation registers BEFORE the library is imported. The bundled
 *    Lambda imports the whole app graph eagerly, so by the time init() runs
 *    those modules are already loaded and the patch no-ops. Adding them would
 *    ship dead instrumentation; the honest path is undici now + (when richer
 *    DB/SES spans are wanted) the ADOT layer's `--import` loader hook later.
 *
 *  • X-Ray compatibility: the AWS X-Ray id generator (epoch-prefixed trace ids)
 *    and propagator (`X-Amzn-Trace-Id`) let our spans share a trace id with the
 *    Lambda's own Active-tracing root segment, so X-Ray stitches them together.
 *
 *  • Lambda flush: the execution environment FREEZES the process the instant the
 *    handler returns, so a batch processor would lose buffered spans. The
 *    handler calls flushTracing() in a `finally` (see handler.ts). No-op off.
 */
import { parseEnv } from "./env.js";

/**
 * Minimal shape we need back from the provider: force-flush buffered spans
 * (per Lambda invocation) and shut down (tests). Kept structural so this module
 * has no static dependency on the heavy SDK types.
 */
interface TracerProviderHandle {
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

let provider: TracerProviderHandle | null = null;
let initPromise: Promise<void> | null = null;

/** Whether app-level OpenTelemetry tracing is switched on (ENABLE_TRACING). */
export function isTracingEnabled(): boolean {
  return parseEnv().ENABLE_TRACING;
}

/**
 * Start the tracer provider exactly once. Idempotent and concurrency-safe (the
 * in-flight promise is memoised), so the Lambda handler can `await initTracing()`
 * on every invocation and only the first cold call does real work.
 *
 * A no-op — importing nothing heavy — unless ENABLE_TRACING=true.
 */
export function initTracing(): Promise<void> {
  if (!initPromise) initPromise = doInit();
  return initPromise;
}

async function doInit(): Promise<void> {
  const env = parseEnv();
  if (!env.ENABLE_TRACING) return;

  // Dynamic imports keep the OpenTelemetry graph out of the default cold start.
  const [
    { resourceFromAttributes },
    { NodeTracerProvider },
    { BatchSpanProcessor, SimpleSpanProcessor, ConsoleSpanExporter },
    { AWSXRayIdGenerator },
    { AWSXRayPropagator },
    { registerInstrumentations },
    { UndiciInstrumentation },
  ] = await Promise.all([
    import("@opentelemetry/resources"),
    import("@opentelemetry/sdk-trace-node"),
    import("@opentelemetry/sdk-trace-base"),
    import("@opentelemetry/id-generator-aws-xray"),
    import("@opentelemetry/propagator-aws-xray"),
    import("@opentelemetry/instrumentation"),
    import("@opentelemetry/instrumentation-undici"),
  ]);

  // Pick the export sink from OTEL_TRACES_EXPORTER:
  //   console → print spans to stdout (local "see the trace" demo)
  //   otlp    → OTLP/HTTP to OTEL_EXPORTER_OTLP_ENDPOINT (the ADOT collector
  //             layer at http://localhost:4318 in prod, or any OTLP backend)
  //   none    → create spans (so logs still carry trace ids) but export nothing
  const spanProcessors = [];
  if (env.OTEL_TRACES_EXPORTER === "console") {
    spanProcessors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));
  } else if (env.OTEL_TRACES_EXPORTER === "otlp") {
    // The exporter reads OTEL_EXPORTER_OTLP_ENDPOINT / *_TRACES_ENDPOINT from
    // the environment itself — standard OTel configuration, set via Terraform.
    const { OTLPTraceExporter } = await import(
      "@opentelemetry/exporter-trace-otlp-http"
    );
    spanProcessors.push(new BatchSpanProcessor(new OTLPTraceExporter()));
  }

  const p = new NodeTracerProvider({
    resource: resourceFromAttributes({
      "service.name": "shop-api",
      "service.version": "0.1.0",
      "deployment.environment": env.NODE_ENV,
    }),
    // X-Ray-compatible (epoch-prefixed) trace ids so the collector can map our
    // spans onto the Lambda's root segment.
    idGenerator: new AWSXRayIdGenerator(),
    spanProcessors,
  });

  // register() installs the GLOBAL tracer provider + an AsyncLocalStorage
  // context manager (so trace.getActiveSpan() resolves inside route handlers
  // AND the Pino mixin) + the X-Ray propagator for the trace-header hop.
  p.register({ propagator: new AWSXRayPropagator() });

  // undici (global fetch): the one downstream instrumentation that survives the
  // bundle — see the file header for why pg/aws-sdk are deliberately excluded.
  registerInstrumentations({
    instrumentations: [new UndiciInstrumentation()],
  });

  provider = p;
}

/**
 * Flush buffered spans before the Lambda container freezes. Never throws —
 * telemetry must never break a request. No-op when tracing is off.
 */
export async function flushTracing(): Promise<void> {
  if (!provider) return;
  try {
    await provider.forceFlush();
  } catch {
    // Swallow: a telemetry-export hiccup must not surface as a request failure.
  }
}

/** Test-only: tear the provider down and reset module state between suites. */
export async function _shutdownTracingForTests(): Promise<void> {
  if (provider) {
    await provider.shutdown();
    provider = null;
  }
  initPromise = null;
}
