import {
  SQSClient,
  SendMessageCommand,
  type SQSClientConfig,
} from "@aws-sdk/client-sqs";
import type { EmailTransport, OutgoingEmail, SendResult } from "../types.js";
import { encodeEmailQueueEnvelope } from "../queue/envelope.js";

/**
 * SQS transport — durable email delivery for production.
 *
 * Instead of calling SES inline (one un-retried attempt inside the API
 * request), `send` enqueues the rendered email onto an SQS queue. The
 * email-fn Lambda (src/queue/handler.ts) consumes the queue and performs
 * the real SES send; SQS redelivers on failure and parks exhausted
 * messages in a DLQ that a CloudWatch alarm watches.
 *
 * Why this shape (2026 serverless baseline, AWS prescriptive guidance):
 *
 *   - "Accepted" now means *durably persisted*, not "SES happened to be
 *     up". That is the property EU Directive 2011/83/EU Art. 8(7) (as
 *     amended by 2023/2673, mandatory 2026-06-19) cares about for the
 *     confirmation-of-contract and withdrawal receipts: a transient SES
 *     outage delays delivery instead of silently dropping it.
 *   - SES latency and throttling leave the API request path entirely.
 *   - A STANDARD queue, not FIFO: ordering between independent emails is
 *     meaningless, and standard queues avoid FIFO's throughput ceilings.
 *     The cost is at-least-once delivery — in the rare redelivery case
 *     the customer gets a duplicate email, which is harmless; SES itself
 *     has the same caveat (a timed-out SendEmail may already have been
 *     accepted). Never-lost beats exactly-once here.
 *
 * The producer keeps the existing best-effort posture: callers wrap
 * `send` in try/catch. SQS being unreachable is dramatically rarer than
 * SES failing a specific send, so the unprotected window shrinks from
 * "any SES error" to "regional SQS outage during the request".
 */

export interface SqsTransportOptions {
  /** Full queue URL (https://sqs.<region>.amazonaws.com/<acct>/<name>). */
  queueUrl: string;
  /** AWS region of the queue. eu-central-1 for this project (GDPR residency). */
  region: string;
  /** Injectable client for tests; production constructs one from `region`. */
  client?: SQSClient;
}

export function createSqsTransport(opts: SqsTransportOptions): EmailTransport {
  const config: SQSClientConfig = { region: opts.region };
  // Lazy singleton per Lambda container, same pattern as the SES transport.
  const client = opts.client ?? new SQSClient(config);

  return {
    async send(email: OutgoingEmail): Promise<SendResult> {
      const command = new SendMessageCommand({
        QueueUrl: opts.queueUrl,
        MessageBody: encodeEmailQueueEnvelope(email),
      });
      const result = await client.send(command);
      // The id of the QUEUE message — proof of durable acceptance. The
      // eventual SES message id is logged by the consumer (email_queue_sent).
      return { messageId: result.MessageId ?? "unknown" };
    },
  };
}
