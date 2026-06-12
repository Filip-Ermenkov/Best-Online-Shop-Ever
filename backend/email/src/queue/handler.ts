import { createSesTransport } from "../transports/ses.js";
import {
  createEmailQueueConsumer,
  type EmailQueueBatchResponse,
  type EmailQueueEvent,
} from "./consumer.js";

/**
 * AWS Lambda entry point for email-fn — the queue consumer deployable.
 *
 * Bundled by `npm run build:lambda` in this workspace (build.mjs →
 * dist/handler.js); Terraform zips dist/ and wires the SQS event source
 * mapping with `ReportBatchItemFailures` (see infra/email-fn.tf).
 *
 * This function deliberately knows nothing about the database and holds
 * no DATABASE_URL — its IAM role can send email and consume the queue,
 * nothing else (least privilege; see infra/email-fn.tf).
 *
 * Environment (set by Terraform, validated at first invoke — a
 * misconfigured function fails its first poll, the messages redeliver,
 * and the DLQ alarm surfaces the problem instead of mail vanishing):
 *
 *   EMAIL_FROM              required — verified SES sender mailbox.
 *   EMAIL_AWS_REGION        optional — defaults to eu-central-1.
 *   EMAIL_CONFIGURATION_SET optional — SES configuration set ("" = none).
 */

interface EmailFnEnv {
  from: string;
  region: string;
  configurationSetName: string | undefined;
}

function readEnv(): EmailFnEnv {
  const from = process.env.EMAIL_FROM ?? "";
  if (from.length === 0) {
    throw new Error("[email-fn] EMAIL_FROM is required");
  }
  const configurationSet = process.env.EMAIL_CONFIGURATION_SET ?? "";
  return {
    from,
    region: process.env.EMAIL_AWS_REGION ?? "eu-central-1",
    configurationSetName:
      configurationSet.length > 0 ? configurationSet : undefined,
  };
}

/** Built once per Lambda container, on the first invocation. */
let consumer:
  | ((event: EmailQueueEvent) => Promise<EmailQueueBatchResponse>)
  | null = null;

function getConsumer(): (
  event: EmailQueueEvent,
) => Promise<EmailQueueBatchResponse> {
  if (consumer) return consumer;
  const env = readEnv();
  consumer = createEmailQueueConsumer({
    transport: createSesTransport({
      region: env.region,
      from: env.from,
      configurationSetName: env.configurationSetName,
    }),
  });
  return consumer;
}

export const handler = async (
  event: EmailQueueEvent,
): Promise<EmailQueueBatchResponse> => {
  return getConsumer()(event);
};
