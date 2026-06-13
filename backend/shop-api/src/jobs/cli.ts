/**
 * Local job runner — the dev/ops counterpart of the Lambda handler:
 *
 *   npm --workspace @shop/api run job -- pickup-expiry
 *   npm --workspace @shop/api run job -- unverified-cleanup --now=2026-06-20T01:00:00Z
 *   npm --workspace @shop/api run job -- catalog-backup
 *
 * Reads .env like server.ts. `--now=<ISO>` overrides the job's clock so the
 * day-6/day-7 windows and pickup deadlines can be exercised against a local
 * database without waiting — it claims rows exactly like a real run would,
 * so use it against dev/test data only.
 *
 * Live-queue guard: with EMAIL_TRANSPORT=sqs this CLI would enqueue REAL
 * emails onto the deployed queue (email-fn → SES) — a stray .env line is
 * enough (hit on 2026-06-12: a leftover live-drill override sent two local
 * drill emails to the production queue). The CLI therefore refuses `sqs`
 * unless `--allow-sqs` is passed, and always announces the active
 * transport. The Lambda path (handler.ts) is unaffected — sqs is the
 * intended transport there.
 */
import "dotenv/config";
import { parseEnv } from "../lib/env.js";
import { isJobName, JOB_NAMES, runJob } from "./runner.js";

const args = process.argv.slice(2);
const jobArg = args.find((a) => !a.startsWith("--"));
const nowArg = args.find((a) => a.startsWith("--now="));
const allowSqs = args.includes("--allow-sqs");

const env = parseEnv();
// eslint-disable-next-line no-console
console.error(`[job] email transport: ${env.EMAIL_TRANSPORT}`);
if (env.EMAIL_TRANSPORT === "sqs" && !allowSqs) {
  // eslint-disable-next-line no-console
  console.error(
    `[job] REFUSING to run: EMAIL_TRANSPORT=sqs would enqueue real emails onto\n` +
      `[job]   ${env.EMAIL_QUEUE_URL}\n` +
      `[job] For local drills set EMAIL_TRANSPORT=console in backend/shop-api/.env\n` +
      `[job] (check for duplicate EMAIL_TRANSPORT lines — the LAST one wins).\n` +
      `[job] If the live queue is really what you want, re-run with --allow-sqs.`,
  );
  process.exit(2);
}

if (!jobArg || !isJobName(jobArg)) {
  // eslint-disable-next-line no-console
  console.error(
    `Usage: npm --workspace @shop/api run job -- <job> [--now=<ISO timestamp>]\n` +
      `Known jobs: ${JOB_NAMES.join(", ")}`,
  );
  process.exit(2);
}

let now: Date | undefined;
if (nowArg) {
  now = new Date(nowArg.slice("--now=".length));
  if (Number.isNaN(now.getTime())) {
    // eslint-disable-next-line no-console
    console.error(`Invalid --now value: ${nowArg.slice("--now=".length)}`);
    process.exit(2);
  }
  // eslint-disable-next-line no-console
  console.error(
    `[job] clock override active: ${now.toISOString()} — dev/test databases only`,
  );
}

runJob(jobArg, { now })
  .then((result) => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ job: jobArg, ...result }, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
