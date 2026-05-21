import { describe, expect, it, vi } from "vitest";
import {
  BREACHED_PASSWORD_CONSTANTS,
  checkPasswordBreached,
} from "../src/breached-password.js";

/**
 * SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8 (uppercase).
 * The first 5 chars are the prefix sent to HIBP.
 *   prefix: 5BAA6
 *   suffix: 1E4C9B93F3F0682250B6CF8331B7EE68FD8
 *
 * This vector is canonical — HIBP themselves use it in the v3 docs.
 * Anchor every "did we hash and slice correctly?" assertion to it.
 */
const PASSWORD_VECTOR = "password";
const PASSWORD_PREFIX = "5BAA6";
const PASSWORD_SUFFIX = "1E4C9B93F3F0682250B6CF8331B7EE68FD8";

/**
 * Build a stub Response mimicking the HIBP `range/` body.
 *
 *   - `count` controls how many breaches the suffix is reported in.
 *   - Includes one padding row (count=0) and one decoy real row so we
 *     prove the parser matches by full suffix, not by prefix or position.
 */
function mockHibpResponse(suffix: string, count: number): Response {
  const lines = [
    "0000000000000000000000000000000000A:0", // padding row, must be ignored
    `BADBADBADBADBADBADBADBADBADBADBADBA:42`, // decoy real row, different suffix
    `${suffix}:${count}`, // the row we expect the parser to find
    `00000000000000000000000000000000000:0`, // more padding
  ];
  return new Response(lines.join("\r\n"), {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

describe("checkPasswordBreached — happy path", () => {
  it("flags 'password' as breached when HIBP returns count >= 1", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockHibpResponse(PASSWORD_SUFFIX, 12345678),
    );
    const result = await checkPasswordBreached(PASSWORD_VECTOR, {
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(result.breached).toBe(true);
    expect(result.occurrences).toBe(12345678);
    expect(result.checkSucceeded).toBe(true);
  });

  it("does not flag a password whose suffix is absent", async () => {
    // Response contains a different real row + only padding for the rest.
    const body = [
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:99",
      "0000000000000000000000000000000000A:0",
    ].join("\r\n");
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(body, { status: 200 }));
    const result = await checkPasswordBreached(PASSWORD_VECTOR, {
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(result.breached).toBe(false);
    expect(result.occurrences).toBe(0);
    expect(result.checkSucceeded).toBe(true);
  });

  it("treats a suffix match with count=0 (padded row) as not breached", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(mockHibpResponse(PASSWORD_SUFFIX, 0));
    const result = await checkPasswordBreached(PASSWORD_VECTOR, {
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(result.breached).toBe(false);
    expect(result.occurrences).toBe(0);
    expect(result.checkSucceeded).toBe(true);
  });

  it("accepts LF line endings as well as CRLF", async () => {
    // HIBP spec says CRLF, but real-world proxies sometimes rewrite to LF.
    // The parser must be robust to both.
    const body = [
      "0000000000000000000000000000000000A:0",
      `${PASSWORD_SUFFIX}:7`,
    ].join("\n"); // ← LF, not CRLF
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(body, { status: 200 }));
    const result = await checkPasswordBreached(PASSWORD_VECTOR, {
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(result.breached).toBe(true);
    expect(result.occurrences).toBe(7);
  });
});

describe("checkPasswordBreached — request shape", () => {
  it("requests the correct 5-character uppercase prefix", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockHibpResponse(PASSWORD_SUFFIX, 1),
    );
    await checkPasswordBreached(PASSWORD_VECTOR, {
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const url = fetcher.mock.calls[0]?.[0] as string;
    expect(url).toBe(
      `${BREACHED_PASSWORD_CONSTANTS.PWNED_API}${PASSWORD_PREFIX}`,
    );
  });

  it("sends Add-Padding, User-Agent, and Accept headers", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      mockHibpResponse(PASSWORD_SUFFIX, 1),
    );
    await checkPasswordBreached(PASSWORD_VECTOR, {
      fetcher: fetcher as unknown as typeof fetch,
    });
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Add-Padding"]).toBe("true");
    expect(headers["User-Agent"]).toBe(
      BREACHED_PASSWORD_CONSTANTS.USER_AGENT,
    );
    expect(headers["Accept"]).toBe("text/plain");
  });
});

describe("checkPasswordBreached — fail-open paths", () => {
  it("fails open on non-2xx (e.g. 503)", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 503 }));
    const result = await checkPasswordBreached(PASSWORD_VECTOR, {
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(result).toEqual({
      breached: false,
      occurrences: 0,
      checkSucceeded: false,
    });
  });

  it("fails open on rate-limit (429)", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 429 }));
    const result = await checkPasswordBreached(PASSWORD_VECTOR, {
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(result.checkSucceeded).toBe(false);
    expect(result.breached).toBe(false);
  });

  it("fails open on fetch throwing (network error / TLS / DNS)", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValue(new TypeError("fetch failed"));
    const result = await checkPasswordBreached(PASSWORD_VECTOR, {
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(result.checkSucceeded).toBe(false);
    expect(result.breached).toBe(false);
  });

  it("fails open when the timeout fires before HIBP responds", async () => {
    // Fetcher that respects the abort signal: rejects when aborted.
    const fetcher = vi.fn(
      (_url: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
          // Never resolves on its own — the only path out is the abort.
        }),
    );
    const result = await checkPasswordBreached(PASSWORD_VECTOR, {
      fetcher: fetcher as unknown as typeof fetch,
      timeoutMs: 5,
    });
    expect(result.checkSucceeded).toBe(false);
    expect(result.breached).toBe(false);
  });

  it("fails open when the external signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const fetcher = vi.fn(
      (_url: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(new DOMException("aborted", "AbortError"));
            return;
          }
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const result = await checkPasswordBreached(PASSWORD_VECTOR, {
      fetcher: fetcher as unknown as typeof fetch,
      signal: ac.signal,
    });
    expect(result.checkSucceeded).toBe(false);
  });

  it("fails open on a malformed body (no parseable lines)", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response("totally not the right shape", { status: 200 }));
    const result = await checkPasswordBreached(PASSWORD_VECTOR, {
      fetcher: fetcher as unknown as typeof fetch,
    });
    // 200 + parseable-but-empty is "we asked, suffix wasn't there" —
    // checkSucceeded=true, breached=false. This documents the boundary.
    expect(result.checkSucceeded).toBe(true);
    expect(result.breached).toBe(false);
    expect(result.occurrences).toBe(0);
  });
});

describe("checkPasswordBreached — constants are sane", () => {
  it("threshold is 1 (reject on first appearance)", () => {
    expect(BREACHED_PASSWORD_CONSTANTS.MIN_OCCURRENCES_TO_REJECT).toBe(1);
  });

  it("HIBP API base URL is correct", () => {
    expect(BREACHED_PASSWORD_CONSTANTS.PWNED_API).toBe(
      "https://api.pwnedpasswords.com/range/",
    );
  });

  it("User-Agent identifies the project and a contact path", () => {
    // HIBP requires a UA; a generic 'node' or '' UA gets 403.
    expect(BREACHED_PASSWORD_CONSTANTS.USER_AGENT).toMatch(
      /BestOnlineShopEver.+\(.+\)/,
    );
  });
});
