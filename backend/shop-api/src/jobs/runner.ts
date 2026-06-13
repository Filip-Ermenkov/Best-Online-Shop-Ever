import type { Logger } from "pino";
import { logger as rootLogger } from "../lib/logger.js";
import { runCatalogBackupJob } from "./catalog-backup.js";
import { runPickupExpiryJob } from "./pickup-expiry.js";
import { runUnverifiedCleanupJob } from "./unverified-cleanup.js";

/**
 * Job registry + dispatcher. One place maps the names EventBridge Scheduler
 * sends (the schedules' `input` payloads in infra/scheduler.tf) to the job
 * implementations. The Lambda handler and the local CLI both go through
 * here, so a job behaves identically on a laptop and in production.
 *
 * Error posture: job failures PROPAGATE. The Lambda is invoked
 * asynchronously by the Scheduler, so a throw → Lambda's async retries
 * (2, spaced) → the scheduler-fn Errors alarm. There is deliberately no
 * job-level DLQ/redrive: every job is an idempotent full-scan sweep, so the
 * next scheduled run IS the redrive — nothing is lost with a missed run,
 * the alarm exists so an operator notices a *persistently* failing job.
 */

export const JOB_NAMES = [
  "pickup-expiry",
  "unverified-cleanup",
  "catalog-backup",
] as const;

export type JobName = (typeof JOB_NAMES)[number];

export function isJobName(value: string): value is JobName {
  return (JOB_NAMES as readonly string[]).includes(value);
}

export interface RunJobOptions {
  /** Injected clock for tests and the CLI's --now override. */
  now?: Date;
  logger?: Logger;
}

export async function runJob(
  job: JobName,
  opts?: RunJobOptions,
): Promise<Record<string, unknown>> {
  const logger = (opts?.logger ?? rootLogger).child({ job });
  const startedAt = Date.now();
  logger.info("job_started");
  try {
    let result: Record<string, unknown>;
    switch (job) {
      case "pickup-expiry":
        result = { ...(await runPickupExpiryJob({ now: opts?.now, logger })) };
        break;
      case "unverified-cleanup":
        result = {
          ...(await runUnverifiedCleanupJob({ now: opts?.now, logger })),
        };
        break;
      case "catalog-backup":
        result = { ...(await runCatalogBackupJob({ now: opts?.now, logger })) };
        break;
    }
    logger.info(
      { durationMs: Date.now() - startedAt, ...result },
      "job_completed",
    );
    return result;
  } catch (err) {
    logger.error({ err, durationMs: Date.now() - startedAt }, "job_failed");
    throw err;
  }
}
