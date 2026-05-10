import { randomUUID } from "node:crypto";
import type { EmailTransport, OutgoingEmail, SendResult } from "../types.js";

/**
 * In-memory transport for tests. Records every email; offers query helpers.
 *
 * Tests can:
 *   - assert that an email was sent at all
 *   - assert template id, subject, recipient
 *   - extract the action URL from the body (verifying the verify-flow works
 *     end-to-end without ever actually mailing)
 *
 * Each test gets a fresh transport via per-test setup, so there is no
 * cross-test leakage even with file-parallel tests.
 */
export interface StubEmailTransport extends EmailTransport {
  readonly sent: ReadonlyArray<OutgoingEmail>;
  reset(): void;
  /** Find the most recent email matching a predicate. Last write wins. */
  findLast(
    predicate: (email: OutgoingEmail) => boolean,
  ): OutgoingEmail | undefined;
  /** Pull the first http(s) URL from an email's text body. */
  extractUrl(email: OutgoingEmail): string | null;
}

export function createStubTransport(): StubEmailTransport {
  const sent: OutgoingEmail[] = [];

  return {
    get sent() {
      return sent;
    },
    async send(email: OutgoingEmail): Promise<SendResult> {
      sent.push(email);
      return { messageId: `stub-${randomUUID()}` };
    },
    reset(): void {
      sent.length = 0;
    },
    findLast(predicate): OutgoingEmail | undefined {
      for (let i = sent.length - 1; i >= 0; i--) {
        const e = sent[i];
        if (e && predicate(e)) return e;
      }
      return undefined;
    },
    extractUrl(email): string | null {
      const m = email.text.match(/https?:\/\/[^\s)]+/);
      return m ? m[0] : null;
    },
  };
}
