import { describe, expect, it, vi } from "vitest";
import { createEmailQueueConsumer } from "../src/queue/consumer.js";
import type {
  EmailQueueLogger,
  EmailQueueRecord,
} from "../src/queue/consumer.js";
import { encodeEmailQueueEnvelope } from "../src/queue/envelope.js";
import { createStubTransport } from "../src/transports/stub.js";
import type {
  EmailTransport,
  OutgoingEmail,
  SendResult,
} from "../src/types.js";

function makeEmail(overrides: Partial<OutgoingEmail> = {}): OutgoingEmail {
  return {
    to: "ivan@example.com",
    subject: "Тема",
    html: "<p>тяло</p>",
    text: "тяло",
    templateId: "orders.order-confirmation",
    ...overrides,
  };
}

function makeRecord(id: string, email: OutgoingEmail): EmailQueueRecord {
  return { messageId: id, body: encodeEmailQueueEnvelope(email) };
}

/** Capture logger so tests can assert on structured events without stdout. */
function captureLogger(): {
  logger: EmailQueueLogger;
  entries: { level: string; fields: Record<string, unknown>; msg: string }[];
} {
  const entries: {
    level: string;
    fields: Record<string, unknown>;
    msg: string;
  }[] = [];
  return {
    entries,
    logger: {
      info: (fields, msg) => entries.push({ level: "info", fields, msg }),
      warn: (fields, msg) => entries.push({ level: "warn", fields, msg }),
      error: (fields, msg) => entries.push({ level: "error", fields, msg }),
    },
  };
}

describe("email queue consumer", () => {
  it("sends every record, preserves content, and reports no failures", async () => {
    const transport = createStubTransport();
    const { logger } = captureLogger();
    const consumer = createEmailQueueConsumer({ transport, logger });

    const a = makeEmail({ to: "a@example.com", subject: "Първа" });
    const b = makeEmail({
      to: "b@example.com",
      subject: "Втора",
      headers: { "X-H": "v" },
    });

    const response = await consumer({
      Records: [makeRecord("m-1", a), makeRecord("m-2", b)],
    });

    expect(response.batchItemFailures).toEqual([]);
    expect(transport.sent).toHaveLength(2);
    // Content survives encode → decode → send unchanged (incl. Bulgarian copy
    // and optional headers).
    expect(transport.sent[0]).toEqual(a);
    expect(transport.sent[1]).toEqual(b);
  });

  it("reports only the failed record — partial batch, no collateral retries", async () => {
    const sent: OutgoingEmail[] = [];
    const transport: EmailTransport = {
      async send(email): Promise<SendResult> {
        if (email.to === "broken@example.com") {
          throw new Error("MessageRejected: address suppressed");
        }
        sent.push(email);
        return { messageId: `ses-${sent.length}` };
      },
    };
    const { logger } = captureLogger();
    const consumer = createEmailQueueConsumer({ transport, logger });

    const response = await consumer({
      Records: [
        makeRecord("m-ok-1", makeEmail({ to: "a@example.com" })),
        makeRecord("m-bad", makeEmail({ to: "broken@example.com" })),
        makeRecord("m-ok-2", makeEmail({ to: "c@example.com" })),
      ],
    });

    // Only the failed record redelivers; its batch-mates were sent exactly
    // once and are deleted by Lambda.
    expect(response.batchItemFailures).toEqual([{ itemIdentifier: "m-bad" }]);
    expect(sent.map((e) => e.to)).toEqual(["a@example.com", "c@example.com"]);
  });

  it("fails malformed envelopes without blocking the rest of the batch", async () => {
    const transport = createStubTransport();
    const { logger, entries } = captureLogger();
    const consumer = createEmailQueueConsumer({ transport, logger });

    const response = await consumer({
      Records: [
        { messageId: "m-poison", body: "{definitely not json" },
        makeRecord("m-ok", makeEmail()),
      ],
    });

    expect(response.batchItemFailures).toEqual([
      { itemIdentifier: "m-poison" },
    ]);
    expect(transport.sent).toHaveLength(1);

    const poison = entries.find(
      (e) => e.fields.event === "email_queue_envelope_invalid",
    );
    expect(poison?.level).toBe("error");
    expect(poison?.fields.sqsMessageId).toBe("m-poison");
  });

  it("fails records with an unsupported envelope version", async () => {
    const transport = createStubTransport();
    const { logger } = captureLogger();
    const consumer = createEmailQueueConsumer({ transport, logger });

    const response = await consumer({
      Records: [
        {
          messageId: "m-future",
          body: JSON.stringify({ v: 99, email: makeEmail() }),
        },
      ],
    });

    expect(response.batchItemFailures).toEqual([
      { itemIdentifier: "m-future" },
    ]);
    expect(transport.sent).toHaveLength(0);
  });

  it("logs send failures with template id and message ids — never the recipient", async () => {
    const transport: EmailTransport = {
      async send(): Promise<SendResult> {
        throw new Error("ServiceUnavailable: try again");
      },
    };
    const { logger, entries } = captureLogger();
    const consumer = createEmailQueueConsumer({ transport, logger });

    await consumer({
      Records: [
        makeRecord("m-1", makeEmail({ to: "secret-person@example.com" })),
      ],
    });

    const failure = entries.find(
      (e) => e.fields.event === "email_queue_send_failed",
    );
    expect(failure).toBeDefined();
    expect(failure?.fields.templateId).toBe("orders.order-confirmation");
    expect(failure?.fields.sqsMessageId).toBe("m-1");
    expect(failure?.fields.err).toContain("ServiceUnavailable");
    // PII guard: the recipient address appears nowhere in the log entry.
    expect(JSON.stringify(failure)).not.toContain("secret-person@example.com");
  });

  it("logs successful sends with the provider message id", async () => {
    const transport: EmailTransport = {
      async send(): Promise<SendResult> {
        return { messageId: "ses-real-id" };
      },
    };
    const { logger, entries } = captureLogger();
    const consumer = createEmailQueueConsumer({ transport, logger });

    await consumer({ Records: [makeRecord("m-1", makeEmail())] });

    const sent = entries.find((e) => e.fields.event === "email_queue_sent");
    expect(sent?.level).toBe("info");
    expect(sent?.fields.providerMessageId).toBe("ses-real-id");
    expect(sent?.fields.sqsMessageId).toBe("m-1");
  });

  it("processes records sequentially, in batch order", async () => {
    const order: string[] = [];
    const transport: EmailTransport = {
      async send(email): Promise<SendResult> {
        // Yield to the event loop so out-of-order interleaving WOULD occur if
        // the consumer ran sends concurrently.
        await new Promise((resolve) => setTimeout(resolve, 1));
        order.push(email.subject);
        return { messageId: "x" };
      },
    };
    const { logger } = captureLogger();
    const consumer = createEmailQueueConsumer({ transport, logger });

    await consumer({
      Records: [
        makeRecord("m-1", makeEmail({ subject: "first" })),
        makeRecord("m-2", makeEmail({ subject: "second" })),
        makeRecord("m-3", makeEmail({ subject: "third" })),
      ],
    });

    expect(order).toEqual(["first", "second", "third"]);
  });

  it("default logger emits JSON lines to the console", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const transport = createStubTransport();
    const consumer = createEmailQueueConsumer({ transport });

    await consumer({ Records: [makeRecord("m-1", makeEmail())] });

    expect(log).toHaveBeenCalled();
    const line = log.mock.calls.at(-1)?.[0] as string;
    const parsed = JSON.parse(line);
    expect(parsed.event).toBe("email_queue_sent");
    expect(parsed.level).toBe("info");
    log.mockRestore();
  });
});
