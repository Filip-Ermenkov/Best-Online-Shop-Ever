import { describe, expect, it, vi } from "vitest";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { createSqsTransport } from "../src/transports/sqs.js";
import {
  EMAIL_QUEUE_ENVELOPE_VERSION,
  EmailEnvelopeError,
  MAX_ENVELOPE_BYTES,
  decodeEmailQueueEnvelope,
  encodeEmailQueueEnvelope,
} from "../src/queue/envelope.js";
import type { OutgoingEmail } from "../src/types.js";

const sampleEmail: OutgoingEmail = {
  to: "ivan@example.com",
  subject: "Поръчка № 2026-000123 е потвърдена",
  html: "<p>Благодарим Ви!</p>",
  text: "Благодарим Ви! https://shop.example.com/account/orders/2026-000123",
  templateId: "orders.order-confirmation",
  headers: { "X-Custom": "yes" },
};

describe("SQS transport", () => {
  it("enqueues a versioned envelope of the rendered email", async () => {
    const sendMock = vi.fn().mockResolvedValue({ MessageId: "sqs-id-123" });
    const fakeClient = { send: sendMock } as unknown as SQSClient;

    const t = createSqsTransport({
      queueUrl: "https://sqs.eu-central-1.amazonaws.com/123456789012/shop-email-queue",
      region: "eu-central-1",
      client: fakeClient,
    });

    const result = await t.send(sampleEmail);

    // The id of the durable QUEUE message, not an SES id — proof of acceptance.
    expect(result.messageId).toBe("sqs-id-123");
    expect(sendMock).toHaveBeenCalledTimes(1);

    const command = sendMock.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(SendMessageCommand);
    const input = (command as SendMessageCommand).input;
    expect(input.QueueUrl).toBe(
      "https://sqs.eu-central-1.amazonaws.com/123456789012/shop-email-queue",
    );

    // Bulgarian copy must survive the JSON round trip byte-for-byte.
    const parsed = JSON.parse(input.MessageBody ?? "");
    expect(parsed.v).toBe(EMAIL_QUEUE_ENVELOPE_VERSION);
    expect(parsed.email).toEqual(sampleEmail);
  });

  it("falls back to 'unknown' when SQS omits MessageId", async () => {
    const sendMock = vi.fn().mockResolvedValue({});
    const fakeClient = { send: sendMock } as unknown as SQSClient;

    const t = createSqsTransport({
      queueUrl: "https://sqs.eu-central-1.amazonaws.com/123456789012/q",
      region: "eu-central-1",
      client: fakeClient,
    });

    const result = await t.send(sampleEmail);
    expect(result.messageId).toBe("unknown");
  });
});

describe("email queue envelope", () => {
  it("encode → decode round-trips the email, headers included", () => {
    const decoded = decodeEmailQueueEnvelope(
      encodeEmailQueueEnvelope(sampleEmail),
    );
    expect(decoded).toEqual(sampleEmail);
  });

  it("round-trips an email without optional headers (and adds none)", () => {
    const { headers: _headers, ...noHeaders } = sampleEmail;
    const decoded = decodeEmailQueueEnvelope(
      encodeEmailQueueEnvelope(noHeaders),
    );
    expect(decoded).toEqual(noHeaders);
    expect("headers" in decoded).toBe(false);
  });

  it("rejects bodies that are not valid JSON", () => {
    expect(() => decodeEmailQueueEnvelope("{nope")).toThrowError(
      EmailEnvelopeError,
    );
    expect(() => decodeEmailQueueEnvelope("{nope")).toThrowError(
      /not valid JSON/,
    );
  });

  it("rejects non-object bodies", () => {
    expect(() => decodeEmailQueueEnvelope("[1,2]")).toThrowError(
      /not a JSON object/,
    );
    expect(() => decodeEmailQueueEnvelope('"hello"')).toThrowError(
      /not a JSON object/,
    );
  });

  it("rejects unknown envelope versions (forward-compat guard)", () => {
    const body = JSON.stringify({ v: 2, email: sampleEmail });
    expect(() => decodeEmailQueueEnvelope(body)).toThrowError(
      /unsupported envelope version: 2/,
    );
  });

  it("rejects missing or empty required fields, naming the field (no PII)", () => {
    const { to: _to, ...withoutTo } = sampleEmail;
    expect(() =>
      decodeEmailQueueEnvelope(JSON.stringify({ v: 1, email: withoutTo })),
    ).toThrowError(/email\.to/);

    expect(() =>
      decodeEmailQueueEnvelope(
        JSON.stringify({ v: 1, email: { ...sampleEmail, subject: "" } }),
      ),
    ).toThrowError(/email\.subject/);

    expect(() =>
      decodeEmailQueueEnvelope(
        JSON.stringify({ v: 1, email: { ...sampleEmail, html: 42 } }),
      ),
    ).toThrowError(/email\.html/);
  });

  it("rejects malformed headers", () => {
    expect(() =>
      decodeEmailQueueEnvelope(
        JSON.stringify({ v: 1, email: { ...sampleEmail, headers: ["x"] } }),
      ),
    ).toThrowError(/email\.headers/);

    expect(() =>
      decodeEmailQueueEnvelope(
        JSON.stringify({
          v: 1,
          email: { ...sampleEmail, headers: { "X-N": 5 } },
        }),
      ),
    ).toThrowError(/email\.headers\["X-N"\]/);
  });

  it("refuses to encode an email that exceeds the SQS 256 KiB limit", () => {
    const oversize: OutgoingEmail = {
      ...sampleEmail,
      html: "x".repeat(MAX_ENVELOPE_BYTES),
    };
    expect(() => encodeEmailQueueEnvelope(oversize)).toThrowError(
      /exceeds SQS limit/,
    );
  });
});
