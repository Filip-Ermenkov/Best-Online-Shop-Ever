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
   *   - `ses`     → AWS SESv2 inline; one un-retried attempt per send.
   *   - `sqs`     → enqueue onto the durable email queue; the email-fn
   *                 Lambda performs the SES send with retry + DLQ. The
   *                 production target since the SQS slice (roadmap item 21)
   *                 — closes the EU 2023/2673 durable-medium audit margin.
   *                 Requires EMAIL_QUEUE_URL.
   *   - `stub`    → record-only in-memory. Tests force this via vitest.config.
   *
   * Defaults to `console`. Production deploys must explicitly set `sqs`
   * (or `ses` to send inline without the queue).
   */
  EMAIL_TRANSPORT: z.enum(["console", "ses", "sqs", "stub"]).default("console"),
  /**
   * Full URL of the durable email queue (infra/sqs.tf output
   * `email_queue_url`). Required when EMAIL_TRANSPORT=sqs — enforced by
   * the superRefine below so a half-configured deploy fails at boot, not
   * at the first checkout.
   */
  EMAIL_QUEUE_URL: z.string().default(""),
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
  /**
   * Optional public shop phone number, shown (alongside the support email
   * derived from EMAIL_FROM) on the guest order-tracking page when an order is
   * `shipped` or `ready_for_pickup` — the spec's "данни за контакт с магазина"
   * block (`docs/README.md` §7). Empty string = omit the phone line; the email
   * is always shown. A standalone env var rather than a settings-table lookup
   * because the admin settings slice is not built yet; migrate this to the
   * settings table when it lands.
   */
  SHOP_CONTACT_PHONE: z.string().default(""),

  // ─── Scheduled jobs (scheduler-fn) ───────────────────────────────────────
  /**
   * S3 bucket for the daily catalog backup (infra output
   * `catalog_backup_bucket`). Only the scheduler-fn deployment sets it; the
   * shop-api Lambda and local dev leave it empty. Deliberately NOT enforced
   * via superRefine: this env schema is shared with shop-api, which must boot
   * without backup configuration. The catalog-backup job checks it at run
   * time and throws — an async-invoke failure that surfaces on the
   * scheduler-fn Errors alarm instead of taking a half-configured function
   * through a silent no-op.
   */
  CATALOG_BACKUP_BUCKET: z.string().default(""),
  /**
   * Key prefix inside the backup bucket. The job writes
   * `<prefix><YYYY-MM-DD>.json` (Sofia calendar date), so re-runs of the
   * same day overwrite idempotently instead of accumulating duplicates.
   */
  CATALOG_BACKUP_PREFIX: z
    .string()
    .default("catalog/")
    .transform((s) => (s.length === 0 || s.endsWith("/") ? s : `${s}/`)),

  // ─── Image uploads (assets-fn pipeline, roadmap item 46) ─────────────────
  /**
   * S3 bucket the admin upload presign targets and the assets-fn validator
   * promotes within (infra output `assets_bucket`). Empty = uploads disabled:
   * POST /admin/uploads returns a clean 503 `/problems/uploads-not-configured`
   * rather than minting a URL to a non-existent bucket. Set only on a deploy
   * with `enable_asset_uploads = true`; the storefront and local dev leave it
   * empty (the catalog still renders — images fall back to the placeholder).
   * Deliberately NOT enforced via superRefine: this schema is shared with the
   * validator Lambda, which sets the bucket but not, say, EMAIL_QUEUE_URL.
   */
  ASSET_UPLOAD_BUCKET: z.string().default(""),
  /**
   * Region of the asset bucket — used to construct the S3 client that signs the
   * presigned POST. eu-central-1 (Frankfurt) by GDPR data-residency default,
   * same as EMAIL_AWS_REGION.
   */
  ASSET_AWS_REGION: z.string().default("eu-central-1"),
  /**
   * Hard upper bound on an uploaded image, in bytes (default 10 MiB). Enforced
   * twice: a clean field-level 400 in the route, AND the S3 POST policy's
   * `content-length-range`, so an over-cap upload is refused by S3 itself.
   */
  ASSET_UPLOAD_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),
  /**
   * Lifetime of a minted presigned POST, in seconds (default 5 min). Short by
   * design — long enough for the admin to pick a file and upload, not long
   * enough for a leaked URL to be useful later.
   */
  ASSET_UPLOAD_URL_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(300),

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

  // ─── Distributed tracing (OpenTelemetry, roadmap item 18) ────────────────
  /**
   * Master switch for app-level OpenTelemetry tracing (lib/tracing.ts). Default
   * OFF — and when off, the whole OTel dependency graph is never imported, so
   * the cold-start cost is exactly zero. Production sets it true via Terraform
   * (`enable_tracing`); set it locally to watch traces in the dev log.
   *
   * Mirrors the `BREACHED_PASSWORD_CHECK_ENABLED` "true"/"false" string toggle
   * so it reads identically from a Lambda env var, a `.env`, or vitest.
   */
  ENABLE_TRACING: z
    .enum(["true", "false"])
    .default("false")
    .transform((s) => s === "true"),
  /**
   * Where spans go when ENABLE_TRACING=true:
   *   - `none`    → spans are created (so the Pino logs still carry trace ids)
   *                 but not exported. Safe default; never attempts a network
   *                 export it isn't configured for.
   *   - `console` → print spans to stdout. The local "see the trace" demo.
   *   - `otlp`    → OTLP/HTTP to OTEL_EXPORTER_OTLP_ENDPOINT (a standard OTel
   *                 env var the exporter reads directly). In production that
   *                 endpoint is the ADOT collector Lambda layer on
   *                 http://localhost:4318, which forwards to AWS X-Ray; point
   *                 it anywhere OTLP for a different backend.
   */
  OTEL_TRACES_EXPORTER: z
    .enum(["none", "console", "otlp"])
    .default("none"),

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
}).superRefine((env, ctx) => {
  if (env.EMAIL_TRANSPORT === "sqs" && env.EMAIL_QUEUE_URL.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["EMAIL_QUEUE_URL"],
      message: "EMAIL_QUEUE_URL is required when EMAIL_TRANSPORT=sqs",
    });
  }
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
