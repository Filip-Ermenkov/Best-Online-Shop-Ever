import type { EmailTransport } from "../types.js";
import { decodeEmailQueueEnvelope } from "./envelope.js";

/**
 * Email queue consumer — the core of the email-fn Lambda.
 *
 * Consumes SQS batches and performs the real send through whatever
 * transport it is given (SES in production, the stub in tests). Failure
 * handling follows the 2026 partial-batch standard:
 *
 *   - The event source mapping is configured with
 *     `ReportBatchItemFailures`, so this consumer NEVER throws for a bad
 *     record. It returns the failed `messageId`s in `batchItemFailures`;
 *     only those records become visible again and are redelivered.
 *     Successfully sent emails in the same batch are deleted — a partial
 *     failure can therefore never cause a duplicate send of the records
 *     that DID succeed.
 *
 *   - Every failure mode takes the same path: transient SES errors
 *     (throttling, 5xx — already retried with backoff inside the SDK),
 *     permanent SES rejections (unverified sender, suppressed recipient)
 *     and malformed envelopes all fail the record. SQS redelivers it with
 *     visibility-timeout spacing and, after `maxReceiveCount` attempts,
 *     parks it in the DLQ where a CloudWatch alarm notifies the admin.
 *     The DLQ is the audit trail of undelivered durable-medium emails —
 *     classification cleverness in the consumer would only hide that.
 *
 *   - Records are processed SEQUENTIALLY. Batches are ≤10 and the event
 *     source caps concurrency, so sequential sends keep us comfortably
 *     under the SES send rate without a token bucket.
 *
 * Logs carry template ids and message ids — never recipient addresses or
 * body content (repo logging convention: field names, not PII).
 */

/** Minimal structural slice of the AWS SQS Lambda event (aws-lambda's
 * `SQSEvent`). Declared locally so this package needs no type dependency;
 * the real event is structurally compatible. */
export interface EmailQueueRecord {
  messageId: string;
  body: string;
}

export interface EmailQueueEvent {
  Records: EmailQueueRecord[];
}

/** Shape Lambda expects back when `ReportBatchItemFailures` is enabled
 * (aws-lambda's `SQSBatchResponse`). */
export interface EmailQueueBatchResponse {
  batchItemFailures: { itemIdentifier: string }[];
}

/** Pino-compatible structural logger; the default writes JSON lines to
 * stdout/stderr, which CloudWatch ingests as-is. */
export interface EmailQueueLogger {
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
}

export interface EmailQueueConsumerOptions {
  transport: EmailTransport;
  logger?: EmailQueueLogger;
}

function jsonLine(
  level: "info" | "warn" | "error",
  fields: Record<string, unknown>,
  msg: string,
): void {
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    msg,
    ...fields,
  });
  // eslint-disable-next-line no-console
  if (level === "error") console.error(line);
  // eslint-disable-next-line no-console
  else console.log(line);
}

const defaultLogger: EmailQueueLogger = {
  info: (fields, msg) => jsonLine("info", fields, msg),
  warn: (fields, msg) => jsonLine("warn", fields, msg),
  error: (fields, msg) => jsonLine("error", fields, msg),
};

export function createEmailQueueConsumer(
  opts: EmailQueueConsumerOptions,
): (event: EmailQueueEvent) => Promise<EmailQueueBatchResponse> {
  const logger = opts.logger ?? defaultLogger;

  return async (event: EmailQueueEvent): Promise<EmailQueueBatchResponse> => {
    const batchItemFailures: { itemIdentifier: string }[] = [];

    for (const record of event.Records) {
      let decoded;
      try {
        decoded = decodeEmailQueueEnvelope(record.body);
      } catch (err) {
        // Poison pill. Fail the record so it retries toward the DLQ —
        // never drop a durable-medium email silently, even a broken one.
        logger.error(
          {
            event: "email_queue_envelope_invalid",
            sqsMessageId: record.messageId,
            err: err instanceof Error ? err.message : String(err),
          },
          "email_queue_envelope_invalid",
        );
        batchItemFailures.push({ itemIdentifier: record.messageId });
        continue;
      }

      try {
        const result = await opts.transport.send(decoded);
        logger.info(
          {
            event: "email_queue_sent",
            sqsMessageId: record.messageId,
            providerMessageId: result.messageId,
            templateId: decoded.templateId,
          },
          "email_queue_sent",
        );
      } catch (err) {
        logger.warn(
          {
            event: "email_queue_send_failed",
            sqsMessageId: record.messageId,
            templateId: decoded.templateId,
            err: err instanceof Error ? err.message : String(err),
          },
          "email_queue_send_failed",
        );
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }

    return { batchItemFailures };
  };
}
