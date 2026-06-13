import { z } from "zod";
import { logger } from "../lib/logger.js";
import { JOB_NAMES, runJob } from "./runner.js";

/**
 * AWS Lambda entry point for scheduler-fn. Bundled by build-scheduler.mjs
 * into dist-scheduler/ (its own artifact — the shop-api HTTP bundle never
 * includes the jobs, and this bundle never includes Hono or argon2; it is
 * pure JS and builds on any OS, like email-fn's).
 *
 * EventBridge Scheduler invokes this ASYNCHRONOUSLY with the schedule's
 * static input, e.g. {"job":"pickup-expiry"}. Consequences:
 *   - A malformed/unknown payload throws → Lambda async retries (2) → the
 *     scheduler-fn Errors alarm. Fail loud, never guess a default job.
 *   - Scheduler-side retry_policy + its DLQ only cover DELIVERY failures
 *     (throttle/permission); in-function failures surface HERE, on the
 *     Errors metric. Both alarms exist (infra/observability.tf).
 *   - At-least-once overall — every job is an idempotent sweep (claim
 *     markers / date-keyed writes), so duplicates are harmless no-ops.
 */

const EventSchema = z.object({
  job: z.enum(JOB_NAMES),
});

interface SchedulerContext {
  awsRequestId?: string;
  functionName?: string;
}

let isCold = true;

export const handler = async (
  event: unknown,
  context?: SchedulerContext,
): Promise<Record<string, unknown>> => {
  const child = logger.child({
    awsRequestId: context?.awsRequestId,
    functionName: context?.functionName,
    coldStart: isCold,
  });
  isCold = false;

  const parsed = EventSchema.safeParse(event);
  if (!parsed.success) {
    child.error(
      { issues: parsed.error.issues, knownJobs: JOB_NAMES },
      "scheduler_event_invalid",
    );
    throw new Error("Invalid scheduler event: expected { job: <known job> }");
  }

  return runJob(parsed.data.job, { logger: child });
};
