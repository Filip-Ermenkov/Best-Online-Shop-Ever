import {
  createConsoleTransport,
  createSesTransport,
  createStubTransport,
  type EmailTransport,
  type StubEmailTransport,
} from "@shop/email";
import { parseEnv } from "./env.js";

/**
 * Process-singleton transport. Constructed lazily on first send so module
 * load is cheap (Lambda cold start).
 *
 * Tests override the singleton via `setEmailTransportForTests(stub)` to
 * point at the in-memory recorder. Production never calls that — the env
 * dictates `ses` and the lazy path constructs an SESv2Client once per
 * Lambda container.
 */

let cached: EmailTransport | null = null;

/**
 * Return the active transport, building it from env on first call.
 *
 * The build path is deliberately a switch-on-string: when a future slice
 * adds e.g. an `smtp` transport (Mailpit during dev, third-party SMTP for
 * staging), it appears here as a single new case.
 */
export function getEmailTransport(): EmailTransport {
  if (cached) return cached;
  const env = parseEnv();
  switch (env.EMAIL_TRANSPORT) {
    case "ses":
      cached = createSesTransport({
        region: env.EMAIL_AWS_REGION,
        from: env.EMAIL_FROM,
        configurationSetName:
          env.EMAIL_CONFIGURATION_SET.length > 0
            ? env.EMAIL_CONFIGURATION_SET
            : undefined,
      });
      return cached;
    case "stub":
      cached = createStubTransport();
      return cached;
    case "console":
    default:
      cached = createConsoleTransport();
      return cached;
  }
}

/**
 * Test-only: replace the cached transport. Call from beforeEach with a
 * fresh stub. The transport persists across requests inside the same
 * Vitest worker, but per-test reset is provided via `transport.reset()`.
 */
export function setEmailTransportForTests(transport: EmailTransport): void {
  cached = transport;
}

/**
 * Test-only: type-narrow accessor. Returns the cached transport if it's a
 * stub, throwing otherwise. Lets tests grab the recorder without re-typing
 * `as StubEmailTransport` everywhere.
 */
export function getStubTransportForTests(): StubEmailTransport {
  if (!cached) throw new Error("Email transport not initialised");
  if (typeof (cached as StubEmailTransport).reset !== "function") {
    throw new Error("Active email transport is not a stub");
  }
  return cached as StubEmailTransport;
}

/** Test-only: drop the cache so the next getEmailTransport rebuilds. */
export function _resetEmailTransportForTests(): void {
  cached = null;
}
