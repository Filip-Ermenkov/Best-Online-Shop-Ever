import { afterEach, describe, expect, it, vi } from "vitest";
import { _resetEnvForTests, parseEnv } from "../../src/lib/env.js";
import {
  _resetEmailTransportForTests,
  getEmailTransport,
} from "../../src/lib/emails.js";

/**
 * Configuration tests for the durable email transport (EMAIL_TRANSPORT=sqs,
 * roadmap item 21). The vitest config pins EMAIL_TRANSPORT=stub for the whole
 * suite; these tests mutate process.env locally and restore it, so the
 * per-test stub wiring of every other file is untouched.
 */

const ORIGINALS = {
  EMAIL_TRANSPORT: process.env.EMAIL_TRANSPORT,
  EMAIL_QUEUE_URL: process.env.EMAIL_QUEUE_URL,
} as const;

afterEach(() => {
  if (ORIGINALS.EMAIL_TRANSPORT === undefined) {
    delete process.env.EMAIL_TRANSPORT;
  } else {
    process.env.EMAIL_TRANSPORT = ORIGINALS.EMAIL_TRANSPORT;
  }
  if (ORIGINALS.EMAIL_QUEUE_URL === undefined) {
    delete process.env.EMAIL_QUEUE_URL;
  } else {
    process.env.EMAIL_QUEUE_URL = ORIGINALS.EMAIL_QUEUE_URL;
  }
  _resetEnvForTests();
  _resetEmailTransportForTests();
});

describe("EMAIL_TRANSPORT=sqs configuration", () => {
  it("boot fails fast when EMAIL_QUEUE_URL is missing", () => {
    process.env.EMAIL_TRANSPORT = "sqs";
    delete process.env.EMAIL_QUEUE_URL;
    _resetEnvForTests();

    // parseEnv logs the treeified Zod error before throwing — keep stderr quiet.
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => parseEnv()).toThrowError(/Invalid environment/);
    expect(JSON.stringify(err.mock.calls)).toContain("EMAIL_QUEUE_URL");
    err.mockRestore();
  });

  it("parses with a queue URL and builds the SQS transport", () => {
    process.env.EMAIL_TRANSPORT = "sqs";
    process.env.EMAIL_QUEUE_URL =
      "https://sqs.eu-central-1.amazonaws.com/123456789012/shop-email-queue";
    _resetEnvForTests();
    _resetEmailTransportForTests();

    const env = parseEnv();
    expect(env.EMAIL_TRANSPORT).toBe("sqs");
    expect(env.EMAIL_QUEUE_URL).toContain("shop-email-queue");

    // Construction is offline (no network until send); it must yield a real
    // transport — and NOT the stub recorder.
    const transport = getEmailTransport();
    expect(typeof transport.send).toBe("function");
    expect("reset" in transport).toBe(false);
  });

  it("non-sqs transports do not require EMAIL_QUEUE_URL", () => {
    process.env.EMAIL_TRANSPORT = "console";
    delete process.env.EMAIL_QUEUE_URL;
    _resetEnvForTests();

    const env = parseEnv();
    expect(env.EMAIL_TRANSPORT).toBe("console");
    expect(env.EMAIL_QUEUE_URL).toBe("");
  });
});
