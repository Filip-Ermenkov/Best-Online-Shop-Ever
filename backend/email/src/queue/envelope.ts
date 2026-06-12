import type { OutgoingEmail } from "../types.js";

/**
 * Queue envelope — the wire contract between the SQS transport (producer,
 * runs inside shop-api) and the queue consumer (runs inside the email-fn
 * Lambda). Both halves live in this package so the contract can never
 * drift between deployables.
 *
 * Design notes:
 *
 *   - The payload is the RENDERED email (the same `OutgoingEmail` every
 *     transport accepts), not a semantic `{ template, params }` event.
 *     Templates therefore version with the producer; the consumer stays
 *     template-agnostic and never needs a redeploy when copy changes.
 *     The body contains personal data, so the queue itself is encrypted
 *     at rest (SSE-KMS with the project CMK — see infra/sqs.tf) and
 *     messages are deleted on successful send.
 *
 *   - `v` is an explicit schema version. A consumer that receives an
 *     envelope it does not understand fails that record (NOT the batch),
 *     SQS redelivers, and after maxReceiveCount the message lands in the
 *     DLQ where the alarm surfaces it — a mixed-version deploy can delay
 *     an email but can never silently drop it.
 *
 *   - Decode is strict and throws `EmailEnvelopeError` with a stable,
 *     PII-free message. Malformed messages are poison pills; the consumer
 *     routes them to the DLQ via the same per-record failure path.
 */

export const EMAIL_QUEUE_ENVELOPE_VERSION = 1;

export interface EmailQueueEnvelope {
  v: typeof EMAIL_QUEUE_ENVELOPE_VERSION;
  email: OutgoingEmail;
}

/**
 * SQS SendMessage rejects bodies over 256 KiB. Our largest template (an
 * order confirmation with many line items) renders well under 64 KiB, so
 * hitting this guard means a bug, not a tuning problem — surface it as a
 * permanent error the producer's best-effort try/catch will log.
 */
export const MAX_ENVELOPE_BYTES = 262_144;

export class EmailEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailEnvelopeError";
  }
}

/** Serialise an email for the queue. Throws `EmailEnvelopeError` if oversize. */
export function encodeEmailQueueEnvelope(email: OutgoingEmail): string {
  const envelope: EmailQueueEnvelope = {
    v: EMAIL_QUEUE_ENVELOPE_VERSION,
    email,
  };
  const body = JSON.stringify(envelope);
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > MAX_ENVELOPE_BYTES) {
    throw new EmailEnvelopeError(
      `envelope exceeds SQS limit: ${bytes} bytes (max ${MAX_ENVELOPE_BYTES})`,
    );
  }
  return body;
}

/**
 * Parse + validate a queue message body back into an `OutgoingEmail`.
 * Strict: unknown version, missing fields, or wrong field types all throw.
 * Error messages carry field NAMES only — never recipient or body content.
 */
export function decodeEmailQueueEnvelope(body: string): OutgoingEmail {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new EmailEnvelopeError("body is not valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new EmailEnvelopeError("body is not a JSON object");
  }
  const candidate = parsed as Record<string, unknown>;

  if (candidate.v !== EMAIL_QUEUE_ENVELOPE_VERSION) {
    throw new EmailEnvelopeError(
      `unsupported envelope version: ${String(candidate.v)}`,
    );
  }

  const email = candidate.email;
  if (typeof email !== "object" || email === null || Array.isArray(email)) {
    throw new EmailEnvelopeError("email is not a JSON object");
  }
  const e = email as Record<string, unknown>;

  // Required string fields. `to`, `subject`, `templateId` must be non-empty;
  // `html` and `text` only need to be strings (renderers always fill them,
  // but an empty body is deliverable — a missing one is not).
  for (const field of ["to", "subject", "templateId"] as const) {
    if (typeof e[field] !== "string" || e[field].length === 0) {
      throw new EmailEnvelopeError(`email.${field} must be a non-empty string`);
    }
  }
  for (const field of ["html", "text"] as const) {
    if (typeof e[field] !== "string") {
      throw new EmailEnvelopeError(`email.${field} must be a string`);
    }
  }

  let headers: Record<string, string> | undefined;
  if (e.headers !== undefined) {
    if (
      typeof e.headers !== "object" ||
      e.headers === null ||
      Array.isArray(e.headers)
    ) {
      throw new EmailEnvelopeError("email.headers must be an object");
    }
    for (const [name, value] of Object.entries(e.headers)) {
      if (typeof value !== "string") {
        throw new EmailEnvelopeError(
          `email.headers["${name}"] must be a string`,
        );
      }
    }
    headers = e.headers as Record<string, string>;
  }

  return {
    to: e.to as string,
    subject: e.subject as string,
    html: e.html as string,
    text: e.text as string,
    templateId: e.templateId as string,
    ...(headers !== undefined ? { headers } : {}),
  };
}
