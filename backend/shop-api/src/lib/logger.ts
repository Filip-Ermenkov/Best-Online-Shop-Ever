import pino from "pino";
import { parseEnv } from "./env.js";

/**
 * One pino instance per Lambda warm container (or per local dev process).
 * Bindings:
 *   service — distinguishes shop-api from admin-api/scheduler in CloudWatch.
 *   env     — for filtering "ENV=production AND level>=error" alerts.
 *
 * `pino-lambda` is intentionally NOT wired in here — its Node ESM build leaks
 * `process.stdout` patches that conflict with the local Node server. We add
 * Lambda context (request id, cold start, ARN) inside the handler wrapper
 * (handler.ts) where we have access to the actual Lambda event/context.
 */
const env = parseEnv();

export const logger = pino({
  level: env.LOG_LEVEL,
  base: {
    service: "shop-api",
    env: env.NODE_ENV,
  },
  // Always JSON. CloudWatch ingests JSON natively, and dev logs stay grep-able
  // and structured. Adding pino-pretty as a dev sidecar is left as an opt-in:
  // `npm run dev | pino-pretty` if a developer prefers human-readable output.
  // Avoids the pino transport worker thread, which has historically been
  // fragile inside `tsx watch` (stdio inherits get tangled on reloads).

  // Redact obvious PII fields if they ever leak into a log payload.
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "*.password",
      "*.passwordHash",
      "*.token",
    ],
    censor: "[redacted]",
  },
});

/** Per-request child logger with a stable request id. */
export function requestLogger(requestId: string): pino.Logger {
  return logger.child({ requestId });
}
