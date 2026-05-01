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
