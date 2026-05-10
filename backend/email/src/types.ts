/**
 * Transport-agnostic email shape. The same payload renders in:
 *   - SESv2 SendEmailCommand (production)
 *   - console.log (local dev)
 *   - in-memory recorder (integration tests)
 *
 * Charset is always UTF-8 — Bulgarian copy is the primary use case.
 */
export interface OutgoingEmail {
  /** RFC 5322 mailbox: `Name <addr@example.com>` or just `addr@example.com`. */
  to: string;
  /** Subject line. Templates produce localised values (Bulgarian by default). */
  subject: string;
  /** HTML body. Required — the text body is generated alongside it. */
  html: string;
  /** Plain-text fallback. Required for clients that block HTML, plus deliverability. */
  text: string;
  /**
   * Stable identifier for the template used. Logged on every send; useful for
   * "which templates are being sent" dashboards without leaking PII.
   */
  templateId: string;
  /**
   * Optional headers. Used today for `List-Unsubscribe` on bulk-shaped emails;
   * verification mail does not need it but the field stays open for future
   * templates (newsletters, marketing — both gated behind cookie consent).
   */
  headers?: Record<string, string>;
}

/**
 * Transports return a SendResult so callers can log a stable message-id from
 * SES (X-SES-MESSAGE-ID, attached to bounce/complaint events later) without
 * the caller knowing which transport ran.
 *
 * Every transport returns a synthetic id even in console/stub mode so the
 * surrounding code path is identical across environments.
 */
export interface SendResult {
  /** Provider-issued message id (or a synthetic one in dev/test). */
  messageId: string;
}

/**
 * Minimal contract every transport implements. Async because SES is, and
 * because tests can simulate latency by awaiting.
 *
 * Transports MUST NOT throw on transient errors — they should retry inside
 * (the SDK handles this with exponential backoff for SES). They MAY throw on
 * permanent errors (e.g. unverified sender, body too large). Callers that
 * want best-effort send (registration flow) wrap the call in try/catch.
 */
export interface EmailTransport {
  send(email: OutgoingEmail): Promise<SendResult>;
}
