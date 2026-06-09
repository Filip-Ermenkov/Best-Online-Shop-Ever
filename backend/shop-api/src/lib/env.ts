import { z } from "zod";

/**
 * Environment validation. Process exits at boot if anything required is
 * missing or malformed — fail fast, never half-booted.
 *
 * Why Zod and not just `process.env`? On Lambda, a missing variable shows up
 * not at deploy time but at the first request, where it manifests as a generic
 * 500. Validating at module load surfaces the real problem in CloudWatch
 * before any traffic is served.
 */
const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  PORT: z.coerce.number().int().positive().default(3001),
  CORS_ORIGINS: z
    .string()
    .default("")
    .transform((s) =>
      s
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  CDN_BASE_URL: z
    .string()
    .default("")
    .transform((s) => s.replace(/\/+$/, "")), // strip trailing slashes
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // ─── Email transport ──────────────────────────────────────────────────────
  /**
   * Which transport to use.
   *   - `console` → log payload to stdout (dev default; zero setup).
   *   - `ses`     → AWS SESv2; production. Requires verified sender + IAM.
   *   - `stub`    → record-only in-memory. Tests force this via vitest.config.
   *
   * Defaults to `console`. Production deploys must explicitly set `ses`.
   */
  EMAIL_TRANSPORT: z.enum(["console", "ses", "stub"]).default("console"),
  /**
   * RFC 5322 mailbox of the sender. Must be a verified identity in SES when
   * EMAIL_TRANSPORT=ses. In dev/test it can be any string — the console and
   * stub transports never actually send.
   */
  EMAIL_FROM: z.string().default("Best Online Shop <noreply@example.com>"),
  /**
   * AWS region for SES. eu-central-1 (Frankfurt) is the project's default
   * for GDPR data-residency. Override per environment if needed.
   */
  EMAIL_AWS_REGION: z.string().default("eu-central-1"),
  /**
   * Optional SES configuration set name. Wire bounce/complaint events
   * through this when the suppression-list slice ships. Empty string is
   * treated as "not set" by the transport.
   */
  EMAIL_CONFIGURATION_SET: z.string().default(""),
  /**
   * Public URL of the frontend, used to build clickable links in emails:
   *   `${PUBLIC_APP_BASE_URL}/account/verify-email?token=…`
   *
   * No trailing slash (the transformer strips them). Local dev defaults to
   * the Next.js dev server.
   */
  PUBLIC_APP_BASE_URL: z
    .string()
    .default("http://localhost:3000")
    .transform((s) => s.replace(/\/+$/, "")),

  // ─── Breached-password screening ─────────────────────────────────────────
  /**
   * Toggle the HIBP k-anonymity check on registration and password-reset.
   * Default ON. Two operational uses:
   *
   *   - Tests set this to `false` so they don't hit api.pwnedpasswords.com
   *     on every register-route exercise. The dedicated HIBP test flips it
   *     back on for itself with a stubbed fetch.
   *   - Incident response: if HIBP becomes structurally unavailable for an
   *     extended period and the warn-log volume becomes a problem (per-call
   *     fail-open is the default behaviour anyway), set this to `false` to
   *     silence the noise. Re-enable when upstream recovers.
   */
  BREACHED_PASSWORD_CHECK_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((s) => s === "true"),

  // ─── Admin MFA (TOTP) ────────────────────────────────────────────────────
  //
  // These gate ONLY the /admin/* surface. They intentionally default to "" so
  // the customer-facing app boots without them — an unconfigured admin key
  // surfaces as a clean 500 on an admin route (via loadMfaKey throwing), never
  // as a boot failure that takes down the storefront. Set both in production
  // via SSM Parameter Store (SecureString); generate with
  // `npm --workspace @shop/api run admin:create -- --print-keys` or
  // `openssl rand -base64 32`.
  /**
   * Base64-encoded 32-byte (AES-256) key. Encrypts the TOTP shared secret at
   * rest in users.mfa_secret_encrypted (AES-256-GCM, @shop/auth mfa-crypto.ts).
   * The DB never holds this key, so a DB dump alone cannot mint TOTP codes.
   * Rotating it re-keys nothing automatically — re-enrol the admin after a
   * rotation (single admin, rare event).
   */
  ADMIN_MFA_ENCRYPTION_KEY: z.string().default(""),
  /**
   * HMAC key for the short-lived login challenge tokens that bind the password
   * step to the TOTP step (@shop/auth challenge.ts). Separate from the
   * encryption key by purpose. Any sufficiently long random string.
   */
  ADMIN_MFA_CHALLENGE_KEY: z.string().default(""),
  /**
   * Issuer label shown in the admin's authenticator app and embedded in the
   * otpauth:// provisioning URI.
   */
  ADMIN_MFA_ISSUER: z.string().default("Best Online Shop (Admin)"),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

/**
 * Lazy because Vitest sets env vars after this module is imported (via the
 * `env` block in vitest.config.ts). Calling parseEnv() at request time
 * guarantees we see the values that the test runner injected.
 */
export function parseEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // Don't use the logger here — it depends on env. Use raw console.
    // eslint-disable-next-line no-console
    console.error(
      "[env] Invalid environment:",
      JSON.stringify(z.treeifyError(parsed.error), null, 2),
    );
    throw new Error("Invalid environment");
  }
  cached = parsed.data;
  return cached;
}

/** Test-only: reset the cached env (call from afterEach if you mutate process.env). */
export function _resetEnvForTests(): void {
  cached = null;
}
