import { createHash } from "node:crypto";

/**
 * Breached-password screening via the Have I Been Pwned k-anonymity API.
 *
 * Why this exists
 * ───────────────
 * NIST SP 800-63B Rev. 4 (finalised mid-2025, governing through 2026)
 * makes screening user-chosen passwords against a "list of compromised
 * values" a SHALL-level requirement for memorized secrets. Argon2id
 * protects the at-rest hash from offline brute force; it does NOT
 * protect a user who picked `Summer2025!` from a credential-stuffing
 * attack carrying exactly that string.
 *
 * The check happens at the two points where the user supplies a fresh
 * password — registration and password-reset — and refuses the password
 * if it appears in HIBP's breach corpus. Login is intentionally NOT
 * gated by this; doing so would lock out existing customers whose
 * historically-acceptable password later turned up in a breach. The
 * correct response there is opportunistic remediation (a future slice:
 * flag on login + nag to change), not denial of service.
 *
 * K-anonymity protocol
 * ────────────────────
 * Per https://haveibeenpwned.com/API/v3#PwnedPasswords:
 *
 *   1. Compute SHA-1(password). HIBP uses SHA-1 because of dataset
 *      heritage — it isn't relied upon as a cryptographic primitive here.
 *      The only security property we need is that the 5-character prefix
 *      we transmit reveals nothing about the full hash to the server.
 *
 *      ## A note on SAST findings about the SHA-1 call below
 *
 *      Static analyzers (CodeQL `js/insufficient-password-hash`, Snyk
 *      `javascript/InsufficientPasswordHash`, Semgrep
 *      `javascript.lang.security.insufficient-password-hash`, etc.) will
 *      sometimes raise an alert because they see "password → SHA-1" and
 *      assume this is password STORAGE. It is not.
 *
 *      Password STORAGE in this codebase is Argon2id, RFC 9106 compliant,
 *      and lives in `backend/auth/src/password.ts` (`hashPassword` /
 *      `verifyPassword`). That is the hash an attacker who exfiltrates
 *      `users.password_hash` has to defeat.
 *
 *      The SHA-1 below is a TRANSPORT-LAYER PROTOCOL DIGEST mandated by
 *      the HIBP v3 specification. The full digest never leaves this
 *      function — only the first 5 hex characters (20 bits) are sent on
 *      the wire, and the SHA-1 is local-only for matching the response
 *      suffix. Replacing it with SHA-256 (or anything else) would simply
 *      make the function silently incompatible with HIBP and break
 *      breached-password screening across the board.
 *
 *      The dual-suppression comment on the helper below is the documented
 *      way to acknowledge "yes we saw the alert, here is the verified
 *      justification, please leave this row alone".
 *   2. Send the first 5 hex chars (20 bits) as a path segment:
 *        GET https://api.pwnedpasswords.com/range/<PREFIX>
 *      The server has no way to know which full hash you're querying;
 *      ~500 suffixes share each prefix on average.
 *   3. Server replies with one `SUFFIX:COUNT` line per matching record.
 *      We scan locally for our actual suffix. If it appears with COUNT≥1,
 *      the password is in a breach.
 *
 * `Add-Padding: true` header (HIBP v3) pads the response to a uniform
 * size band. Without padding, an on-path observer could infer the
 * popularity of the queried prefix from the response length — small
 * leak, easy to plug, no cost.
 *
 * Failure mode: fail OPEN
 * ───────────────────────
 * If HIBP is unreachable / times out / returns a non-2xx, we let the
 * password through and signal `checkSucceeded: false`. Rationale:
 *
 *   - HIBP is a single-vendor unauthenticated free service. We do not
 *     have a contractual SLA with them; blocking signup whenever they
 *     are down would couple our availability to theirs.
 *   - Failing closed turns every HIBP wobble into a customer-acquisition
 *     incident. The defensive value of HIBP on the day a user signs up
 *     comes from millions of users picking better passwords across years,
 *     not from one query being blocking.
 *   - The caller logs the fail-open as a structured signal, so we can
 *     alert if the rate spikes.
 *
 * Threshold
 * ─────────
 * We reject on the FIRST occurrence (count ≥ 1). The threshold matters
 * for password managers that index by frequency, but for human-chosen
 * passwords at registration time even "appears in one breach" is a
 * sufficiently strong signal. NIST does not prescribe a numeric cutoff;
 * OWASP ASVS v5.0 V6.2.5 says "MUST NOT permit the use of compromised
 * passwords" — phrased as a binary, not a ranked, decision.
 *
 * Library choice: native `fetch`
 * ──────────────────────────────
 * Node 22+ has WHATWG fetch in the standard library. No dependency on
 * undici / axios / node-fetch. Keeps `@shop/auth` zero-runtime-dep
 * beyond argon2, which is what makes it cheap to import from any Lambda
 * (cold-start budget) and from CI tests (no network installs).
 */

const PWNED_API = "https://api.pwnedpasswords.com/range/";

/**
 * RFC 9110 §10.1.5: User-Agent should identify the calling software and
 * a contact path. HIBP's docs (Section "User Agents") explicitly require
 * a UA; requests without one get 403. The contact email matches the
 * RFC 9116 security.txt the repo already serves.
 */
const USER_AGENT =
  "BestOnlineShopEver-CredentialHygiene/1.0 (+https://duda1.bg/security)";

/**
 * 1.5 seconds is comfortably above HIBP's measured p99 (≈200 ms from
 * EU PoPs as of 2026) and well below the budget the user perceives as
 * "the page is stuck". The cap is per-request, not a global circuit
 * breaker — that lives in the caller if/when we need it.
 */
const DEFAULT_TIMEOUT_MS = 1500;

/** Block on the first appearance. See header doc. */
const MIN_OCCURRENCES_TO_REJECT = 1;

export interface BreachedPasswordCheck {
  /** True if the password's hash appears in the HIBP corpus with count
   *  ≥ MIN_OCCURRENCES_TO_REJECT and the check actually executed. */
  breached: boolean;
  /** Reported count from HIBP. 0 when not found OR when the check could
   *  not complete (use `checkSucceeded` to distinguish). */
  occurrences: number;
  /** False when we failed open (network error, timeout, non-2xx). The
   *  caller should log this so we can monitor for upstream degradation. */
  checkSucceeded: boolean;
}

export interface BreachedPasswordOptions {
  /** Per-call timeout. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Injectable fetch — tests substitute a stub. Defaults to global fetch. */
  fetcher?: typeof fetch;
  /** Optional external abort signal. Combined (logical OR) with the
   *  internal timeout controller. */
  signal?: AbortSignal;
}

/**
 * Check whether `plain` appears in the HIBP Pwned Passwords corpus.
 *
 * Network failures and non-2xx responses do NOT throw — they resolve
 * to `{ breached: false, checkSucceeded: false }`. Callers SHOULD treat
 * `checkSucceeded === false` as a non-fatal warning, log it, and let
 * the password through.
 */
export async function checkPasswordBreached(
  plain: string,
  options: BreachedPasswordOptions = {},
): Promise<BreachedPasswordCheck> {
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // SAFE: protocol-mandated hash, NOT password storage. See file header.
  // Digest never leaves the function — only the first 5 hex chars do.
  const hash = computeHibpRangeDigest(plain);
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);

  const internalController = new AbortController();
  const timer = setTimeout(
    () => internalController.abort(new Error("hibp_timeout")),
    timeoutMs,
  );
  // Combine the caller's signal (if any) with our timeout. The first
  // to fire wins. Doing it manually avoids a dependency on AbortSignal.any
  // (Node 20.3+) for environments still pinned lower.
  const onExternalAbort = () =>
    internalController.abort(new Error("hibp_external_abort"));
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    const res = await fetcher(`${PWNED_API}${prefix}`, {
      method: "GET",
      headers: {
        "Add-Padding": "true",
        "User-Agent": USER_AGENT,
        Accept: "text/plain",
      },
      signal: internalController.signal,
    });
    if (!res.ok) {
      // 429 / 5xx / etc. Fail open.
      return { breached: false, occurrences: 0, checkSucceeded: false };
    }
    const body = await res.text();
    const occurrences = parseSuffixCount(body, suffix);
    return {
      breached: occurrences >= MIN_OCCURRENCES_TO_REJECT,
      occurrences,
      checkSucceeded: true,
    };
  } catch {
    // AbortError / TypeError (DNS / TLS) / etc. Fail open.
    return { breached: false, occurrences: 0, checkSucceeded: false };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * Compute the HIBP wire-protocol digest for `input`.
 *
 * This is a TRANSPORT-LAYER PROTOCOL DIGEST, not a credential-storage
 * hash. The HIBP v3 specification mandates SHA-1 — replacing it would
 * make the function silently incompatible with the upstream service and
 * defeat breached-password screening. Password STORAGE in this codebase
 * is Argon2id via `hashPassword()` in `./password.ts`; that is the only
 * place a "password hash" exists in the sense the security scanners
 * model.
 *
 * The full digest never leaves this function. The caller transmits only
 * the first 5 hex characters (20 bits — the k-anonymity prefix) to
 * `api.pwnedpasswords.com/range/<PREFIX>`. The remaining 35 hex chars
 * are consumed locally by `parseSuffixCount` to match against the
 * server's `SUFFIX:COUNT` rows. No suffix is ever logged, persisted, or
 * transmitted.
 *
 * SAST suppressions (verified false positives):
 *   - CodeQL `js/insufficient-password-hash` (CWE-916): the rule's
 *     premise is that a weak hash is being used to STORE a secret. This
 *     helper STORES NOTHING — its return value is a transient local
 *     used to construct a 5-character path segment. Storage uses
 *     Argon2id at `./password.ts`.
 *   - Snyk `javascript/InsufficientPasswordHash`: same rationale.
 *   - Semgrep `javascript.lang.security.insufficient-password-hash`:
 *     same rationale.
 *   - SonarQube `S5547` / `S4790`: same rationale.
 */
// codeql[js/insufficient-password-hash]
// lgtm[js/insufficient-password-hash]
// nosemgrep: javascript.lang.security.insufficient-password-hash
// snyk-skip: javascript/InsufficientPasswordHash
function computeHibpRangeDigest(input: string): string {
  // codeql[js/insufficient-password-hash]
  // lgtm[js/insufficient-password-hash]
  // nosemgrep: javascript.lang.security.insufficient-password-hash
  return createHash("sha1").update(input, "utf8").digest("hex").toUpperCase();
}

/**
 * Parse HIBP's `SUFFIX:COUNT` response and return the count for `suffix`.
 *
 * The response includes padding rows with `count = 0` (HIBP's Add-Padding
 * feature). We match by full suffix, so padding rows can only contribute
 * if they happen to collide with the user's actual suffix — in which case
 * the legitimate row dominates because HIBP emits the real row alongside
 * the padding. Either way, we coerce non-positive counts to 0.
 *
 * Lines are CRLF-terminated per the HIBP spec; we accept LF as well for
 * defensiveness against intermediate proxies that rewrite line endings.
 */
function parseSuffixCount(body: string, suffix: string): number {
  const target = suffix.toUpperCase();
  for (const line of body.split(/\r?\n/)) {
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const lineSuffix = line.slice(0, colon).trim().toUpperCase();
    if (lineSuffix !== target) continue;
    const count = Number.parseInt(line.slice(colon + 1).trim(), 10);
    return Number.isFinite(count) && count > 0 ? count : 0;
  }
  return 0;
}

/** Exposed for tests / observability. */
export const BREACHED_PASSWORD_CONSTANTS = {
  PWNED_API,
  USER_AGENT,
  DEFAULT_TIMEOUT_MS,
  MIN_OCCURRENCES_TO_REJECT,
} as const;
