/**
 * AWS Lambda entry point.
 *
 * Hono ships its Lambda adapter inside the main package — `hono/aws-lambda`.
 * The adapter accepts API Gateway v1, API Gateway v2, ALB, and Lambda
 * Function URL events transparently.
 *
 * IMPORTANT: nothing here imports the local Node server. Bundling for Lambda
 * picks this file up; @hono/node-server and its dependency tree are NOT
 * included in the Lambda artifact.
 */
import { handle, type LambdaEvent, type LambdaContext } from "hono/aws-lambda";
import { buildApp } from "./app.js";
import { logger } from "./lib/logger.js";
import { flushTracing, initTracing } from "./lib/tracing.js";

const app = buildApp();
const lambdaHandler = handle(app);

/**
 * We wrap Hono's handler so we can attach Lambda-specific bindings
 * (request id from API Gateway, cold-start indicator) to every log line
 * emitted during this invocation. We use AsyncLocalStorage implicitly via
 * pino's child loggers: the `logger` singleton is what middleware reaches
 * for, so binding context to it for the duration of the invocation is the
 * least-invasive way to enrich logs.
 */
let isCold = true;

export const handler = async (event: LambdaEvent, context: LambdaContext) => {
  // Start the tracer provider on the first (cold) invocation. Idempotent and
  // memoised, so warm invocations just await a resolved promise; a no-op (and
  // imports nothing) unless ENABLE_TRACING=true. Awaited before the request so
  // the provider is registered when @hono/otel reaches for it.
  await initTracing();

  const child = logger.child({
    awsRequestId: context.awsRequestId,
    functionName: context.functionName,
    coldStart: isCold,
  });
  isCold = false;

  child.info("invoke");
  try {
    return await lambdaHandler(event, context);
  } catch (err) {
    child.error({ err }, "lambda_unhandled");
    throw err;
  } finally {
    // Lambda freezes the process the moment we return, so flush buffered spans
    // now or lose them. No-op when tracing is off; never throws.
    await flushTracing();
  }
};
