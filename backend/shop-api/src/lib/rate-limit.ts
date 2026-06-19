/**
 * Client-IP extraction for keying the rate limiters.
 *
 * The actual per-IP counters are distributed (Postgres-backed) — see
 * `lib/rate-limit-db.ts`. This module used to also hold an in-memory
 * fixed-window limiter, but that was per-Lambda-container state (the ceiling
 * multiplied by warm-container count and reset on cold start), so it was
 * replaced by the DB-backed limiter and removed. Only the pure IP helper, which
 * is transport-agnostic, remains here.
 */

/**
 * Best-effort client-IP extraction for keying the limiter.
 *
 * In production the request arrives at the Lambda Function URL behind
 * CloudFront, so the left-most `X-Forwarded-For` hop is the real client. We
 * fall back to `unknown` (a single shared bucket) when no XFF is present — the
 * local-dev case. That means local requests share one bucket; the unit tests
 * key explicitly.
 */
export function clientIpFromXff(xff: string | undefined | null): string {
  if (!xff) return "unknown";
  const first = xff.split(",")[0]?.trim();
  return first && first.length > 0 ? first : "unknown";
}
