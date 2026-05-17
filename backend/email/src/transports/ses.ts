import {
  SESv2Client,
  SendEmailCommand,
  type SESv2ClientConfig,
} from "@aws-sdk/client-sesv2";
import type { EmailTransport, OutgoingEmail, SendResult } from "../types.js";

/**
 * SESv2 transport for production.
 *
 * Why SESv2 (not v1 / not Nodemailer)?
 *   - SESv2 is the supported API; v1 (`@aws-sdk/client-ses`) still works but
 *     receives no new features (configuration sets v2 only, list-management
 *     v2 only, account-level suppression v2 only).
 *   - Direct SDK call avoids the Nodemailer layer (one less dependency,
 *     ~250kb smaller bundle), which matters for Lambda cold start. The
 *     SDK retries transient errors with exponential backoff automatically.
 *   - SDK v3 modular client (`@aws-sdk/client-sesv2`, not `aws-sdk`) is what
 *     Lambda Node 22 runtime ships and what AWS recommends post Mar-2024.
 *
 * Production DNS prerequisites (NOT this code's job, but documented here so
 * the next operator finds it):
 *   - Verify the sending domain in SES (creates 3 CNAMEs for DKIM rotation).
 *   - Set up Custom MAIL FROM (`mail.shop.example.com`) so SPF aligns with
 *     the visible `From:` domain (Google/Yahoo/Microsoft 2026 bulk-sender
 *     rules require this).
 *   - Publish a DMARC TXT at `_dmarc.shop.example.com`. Start with `p=none`
 *     to collect aggregate reports, tighten to `p=quarantine` once clean.
 *   - Move out of SES sandbox before going live (sandbox limits sending to
 *     verified recipients only, 200 emails/day).
 */

export interface SesTransportOptions {
  /**
   * AWS region. eu-central-1 (Frankfurt) is the default for this project —
   * matches the EU-data-residency posture documented in docs/ARCHITECTURE.md §1.
   * Override per-deployment via env if a different region is preferred.
   */
  region: string;
  /**
   * Verified sender. RFC 5322 mailbox format: `Name <addr@example.com>`.
   * Must match the `MAIL FROM` identity SES has been configured with.
   */
  from: string;
  /**
   * Optional configuration set name. Use this to enable SES event publishing
   * (bounces, complaints, deliveries) → SNS → Lambda for suppression-list
   * housekeeping. Not required for the verification slice; field is present
   * so the slice that adds bounce handling doesn't need to retrofit it.
   */
  configurationSetName?: string;
  /**
   * Provided SESv2Client. Useful for tests to inject a mock; in production
   * leave undefined and we construct one from `region`.
   */
  client?: SESv2Client;
}

export function createSesTransport(opts: SesTransportOptions): EmailTransport {
  const config: SESv2ClientConfig = { region: opts.region };
  // Lazy: cold start cost only once per Lambda container.
  const client = opts.client ?? new SESv2Client(config);

  return {
    async send(email: OutgoingEmail): Promise<SendResult> {
      const command = new SendEmailCommand({
        FromEmailAddress: opts.from,
        Destination: { ToAddresses: [email.to] },
        Content: {
          Simple: {
            Subject: { Data: email.subject, Charset: "UTF-8" },
            Body: {
              Html: { Data: email.html, Charset: "UTF-8" },
              Text: { Data: email.text, Charset: "UTF-8" },
            },
            // Headers payload is supported by SESv2 Simple content; we
            // pass-through whatever the template provided. List-Unsubscribe,
            // List-Unsubscribe-Post and similar live here.
            ...(email.headers && Object.keys(email.headers).length > 0
              ? {
                  Headers: Object.entries(email.headers).map(
                    ([name, value]) => ({ Name: name, Value: value }),
                  ),
                }
              : {}),
          },
        },
        ...(opts.configurationSetName
          ? { ConfigurationSetName: opts.configurationSetName }
          : {}),
      });

      const result = await client.send(command);

      // SES returns MessageId on every success. The "?? unknown" guard is
      // belt-and-braces — the SDK type marks it optional, but the docs
      // promise it on 200.
      return { messageId: result.MessageId ?? "unknown" };
    },
  };
}
