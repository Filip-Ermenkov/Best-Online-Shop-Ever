import { describe, expect, it } from "vitest";
import {
  generateSessionToken,
  hashSessionToken,
  SESSION_TOKEN_BYTES,
} from "../src/session-tokens.js";

describe("generateSessionToken", () => {
  it("returns a base64url string of the expected length (32 bytes → 43 chars, no padding)", () => {
    const tok = generateSessionToken();
    // 32 bytes encoded as base64url = ceil(32 * 4 / 3) = 43 chars (no =).
    expect(tok).toHaveLength(43);
    // base64url alphabet only.
    expect(tok).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("returns a different token on each call (CSPRNG, no global state)", () => {
    const tokens = new Set(
      Array.from({ length: 100 }, () => generateSessionToken()),
    );
    // 100 tokens of 256 bits each — collision probability is astronomically low.
    expect(tokens.size).toBe(100);
  });

  it("uses 32 bytes of entropy as documented", () => {
    expect(SESSION_TOKEN_BYTES).toBe(32);
  });
});

describe("hashSessionToken", () => {
  it("returns a 64-character lowercase hex SHA-256 digest", () => {
    const hash = hashSessionToken("anything");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — same input maps to same output", () => {
    const t = generateSessionToken();
    expect(hashSessionToken(t)).toBe(hashSessionToken(t));
  });

  it("produces different hashes for different tokens", () => {
    const a = hashSessionToken(generateSessionToken());
    const b = hashSessionToken(generateSessionToken());
    expect(a).not.toBe(b);
  });

  it("matches a known SHA-256 vector (regression sentinel)", () => {
    // sha256("abc") is one of the canonical test vectors from FIPS 180-4.
    expect(hashSessionToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
