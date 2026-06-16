/**
 * Tiny in-memory fixed-window rate limiter.
 *
 * Used by the public guest surface (`routes/guest.ts`):
 *   - find-my-order resend  — 3 / hour / IP (spec §7, "Изгубен tracking линк")
 *   - guest order placement — a generous anti-abuse cap on anonymous POSTs
 *
 * Design notes / honest limits:
 *   - **Per-instance, not distributed.** State lives in this Lambda container's
 *     memory, so the effective limit scales with the number of warm containers.
 *     That is acceptable here: the limiter is an abuse-dampener, not a billing
 *     control, and the security of the tracking token does not depend on it
 *     (the token is 256-bit unguessable). The same in-memory stance is already
 *     used by the CSP-report route's per-IP bucket. If a hard, cluster-wide
 *     guarantee is ever needed, swap the Map for a DynamoDB/Redis counter
 *     behind this same interface — call sites won't change.
 *   - **Bounded memory.** `maxKeys` caps the Map; once full we evict the oldest
 *     window. A flood of distinct IPs can therefore evict honest entries, which
 *     only ever *grants* extra allowance — it never wrongly blocks. Fail-open is
 *     the right bias for a convenience limiter on a public endpoint.
 *   - **Injectable clock.** `now()` is a constructor option so the unit tests
 *     can advance time deterministically instead of sleeping.
 */

export interface RateLimiterOptions {
  /** Max allowed hits per key within one window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Max distinct keys retained. Oldest window evicted past this. Default 10000. */
  maxKeys?: number;
  /** Clock injection for tests. Defaults to Date.now. */
  now?: () => number;
}

export interface RateLimitResult {
  /** True when the hit is within budget (and has been counted). */
  allowed: boolean;
  /** Hits remaining in the current window after this call (never negative). */
  remaining: number;
  /** Epoch ms when the current window resets. */
  resetAt: number;
}

interface Window {
  count: number;
  resetAt: number;
}

export interface RateLimiter {
  /** Count a hit for `key`; returns whether it is within budget. */
  hit(key: string): RateLimitResult;
  /** Test/ops helper: forget all state. */
  reset(): void;
}

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const limit = Math.max(1, Math.floor(opts.limit));
  const windowMs = Math.max(1, Math.floor(opts.windowMs));
  const maxKeys = Math.max(1, Math.floor(opts.maxKeys ?? 10_000));
  const now = opts.now ?? Date.now;
  const windows = new Map<string, Window>();

  function evictIfNeeded(): void {
    if (windows.size < maxKeys) return;
    // Map preserves insertion order; the first key is the oldest-created
    // window. Dropping it is the cheap, fail-open eviction described above.
    const oldest = windows.keys().next().value;
    if (oldest !== undefined) windows.delete(oldest);
  }

  return {
    hit(key: string): RateLimitResult {
      const t = now();
      const existing = windows.get(key);

      if (!existing || t >= existing.resetAt) {
        evictIfNeeded();
        const resetAt = t + windowMs;
        windows.set(key, { count: 1, resetAt });
        return { allowed: true, remaining: limit - 1, resetAt };
      }

      if (existing.count >= limit) {
        return { allowed: false, remaining: 0, resetAt: existing.resetAt };
      }

      existing.count += 1;
      return {
        allowed: true,
        remaining: limit - existing.count,
        resetAt: existing.resetAt,
      };
    },
    reset(): void {
      windows.clear();
    },
  };
}

/**
 * Best-effort client-IP extraction for keying the limiter.
 *
 * In production the request arrives at the Lambda Function URL behind
 * CloudFront, so the left-most `X-Forwarded-For` hop is the real client. We
 * fall back to `unknown` (a single shared bucket) when no XFF is present — the
 * local-dev case. That means local requests share one bucket; the unit tests
 * key explicitly, and the manual test guide notes that restarting `api:dev`
 * clears the in-memory windows.
 */
export function clientIpFromXff(xff: string | undefined | null): string {
  if (!xff) return "unknown";
  const first = xff.split(",")[0]?.trim();
  return first && first.length > 0 ? first : "unknown";
}
