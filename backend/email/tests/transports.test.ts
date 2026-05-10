import { describe, expect, it, vi } from "vitest";
import {
  SESv2Client,
  SendEmailCommand,
} from "@aws-sdk/client-sesv2";
import { createConsoleTransport } from "../src/transports/console.js";
import { createSesTransport } from "../src/transports/ses.js";
import { createStubTransport } from "../src/transports/stub.js";

describe("console transport", () => {
  it("returns a synthetic message id and logs to stdout", async () => {
    const t = createConsoleTransport();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const out = await t.send({
      to: "x@example.com",
      subject: "S",
      html: "<p>hi</p>",
      text: "hi https://example.com/verify",
      templateId: "test",
    });
    expect(out.messageId.startsWith("console-")).toBe(true);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});

describe("stub transport", () => {
  it("records sent emails and supports findLast / extractUrl / reset", async () => {
    const t = createStubTransport();
    expect(t.sent).toHaveLength(0);

    await t.send({
      to: "a@example.com",
      subject: "S1",
      html: "",
      text: "click https://example.com/a",
      templateId: "test",
    });
    await t.send({
      to: "b@example.com",
      subject: "S2",
      html: "",
      text: "click https://example.com/b",
      templateId: "test",
    });

    expect(t.sent).toHaveLength(2);
    const last = t.findLast((e) => e.to === "b@example.com");
    expect(last?.subject).toBe("S2");
    expect(t.extractUrl(last!)).toBe("https://example.com/b");

    t.reset();
    expect(t.sent).toHaveLength(0);
  });
});

describe("SES transport", () => {
  it("constructs a SendEmailCommand with the expected payload", async () => {
    // Mock the SESv2Client.send so we never hit AWS. The mock asserts the
    // command shape we built — that's what production deliverability cares
    // about (Subject UTF-8, HTML + Text bodies, single ToAddress, configset).
    const sendMock = vi.fn().mockResolvedValue({ MessageId: "ses-id-123" });
    const fakeClient = { send: sendMock } as unknown as SESv2Client;

    const t = createSesTransport({
      region: "eu-central-1",
      from: "Best Shop <noreply@shop.example.com>",
      configurationSetName: "default",
      client: fakeClient,
    });

    const result = await t.send({
      to: "ivan@example.com",
      subject: "Потвърдете",
      html: "<p>hi</p>",
      text: "hi",
      templateId: "auth.signup-verification",
      headers: { "X-Custom": "yes" },
    });

    expect(result.messageId).toBe("ses-id-123");
    expect(sendMock).toHaveBeenCalledTimes(1);

    const command = sendMock.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(SendEmailCommand);
    const input = (command as SendEmailCommand).input;
    expect(input.FromEmailAddress).toBe("Best Shop <noreply@shop.example.com>");
    expect(input.Destination?.ToAddresses).toEqual(["ivan@example.com"]);
    expect(input.ConfigurationSetName).toBe("default");
    expect(input.Content?.Simple?.Subject?.Data).toBe("Потвърдете");
    expect(input.Content?.Simple?.Subject?.Charset).toBe("UTF-8");
    expect(input.Content?.Simple?.Body?.Html?.Data).toBe("<p>hi</p>");
    expect(input.Content?.Simple?.Body?.Html?.Charset).toBe("UTF-8");
    expect(input.Content?.Simple?.Body?.Text?.Data).toBe("hi");
    // Headers passed through.
    expect(input.Content?.Simple?.Headers).toEqual([
      { Name: "X-Custom", Value: "yes" },
    ]);
  });

  it("falls back to 'unknown' when SES omits MessageId", async () => {
    const sendMock = vi.fn().mockResolvedValue({});
    const fakeClient = { send: sendMock } as unknown as SESv2Client;

    const t = createSesTransport({
      region: "eu-central-1",
      from: "noreply@example.com",
      client: fakeClient,
    });

    const result = await t.send({
      to: "x@example.com",
      subject: "s",
      html: "<p>h</p>",
      text: "t",
      templateId: "test",
    });
    expect(result.messageId).toBe("unknown");
  });
});
