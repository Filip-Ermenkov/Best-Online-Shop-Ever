import { randomUUID } from "node:crypto";
import type { EmailTransport, OutgoingEmail, SendResult } from "../types.js";

/**
 * Console transport — local development.
 *
 * Why log to stdout rather than open a real SMTP server (mailhog etc.)?
 *   1. Zero-setup. The next agent / contributor doesn't need to install
 *      anything before they can register a test user and "click" the
 *      verification link.
 *   2. The dev URL is the only thing a developer wants — they're never
 *      previewing the *rendering* in dev (that's QA against staging).
 *   3. Logs are already plumbed (pino) — the same env that turns logs on
 *      and off in CI also gates email noise.
 *
 * Output shape is intentionally human-readable. The verification link is
 * surfaced on its own line with a "VERIFY URL ⇒ …" prefix so an `npm run
 * api:dev` watcher can be grep'd from another terminal.
 */
export function createConsoleTransport(): EmailTransport {
  return {
    async send(email: OutgoingEmail): Promise<SendResult> {
      const messageId = `console-${randomUUID()}`;
      // eslint-disable-next-line no-console
      console.log(
        [
          "",
          "─── EMAIL (console transport) ─────────────────────────────────",
          `To:         ${email.to}`,
          `Subject:    ${email.subject}`,
          `Template:   ${email.templateId}`,
          `MessageId:  ${messageId}`,
          extractActionUrl(email.text)
            ? `VERIFY URL ⇒ ${extractActionUrl(email.text)}`
            : null,
          "",
          email.text,
          "───────────────────────────────────────────────────────────────",
          "",
        ]
          .filter((s): s is string => s !== null)
          .join("\n"),
      );
      return { messageId };
    },
  };
}

/**
 * Pull the first http(s) URL out of the plaintext body so the dev terminal
 * surfaces it on a single line. Best-effort — if regex misses, we just don't
 * print the convenience line; the full body is still above.
 */
function extractActionUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s)]+/);
  return match ? match[0] : null;
}
