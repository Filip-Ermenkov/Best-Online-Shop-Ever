import { describe, expect, it } from "vitest";
import {
  GUEST_TRACK_TOKEN_BYTES,
  issueGuestTrackToken,
  isWellFormedTrackToken,
} from "../../src/lib/guest-track.js";
import { clientIpFromXff } from "../../src/lib/rate-limit.js";

/**
 * Pure-unit coverage for the guest tracking-token + client-IP primitives. These
 * run with no DB, mirroring the @shop/auth crypto suites. The per-IP rate limit
 * is now distributed (Postgres-backed) and exercised in
 * tests/lib/rate-limit-db.test.ts; the route-level behaviour is in
 * tests/routes/guest.test.ts.
 */

describe("guest tracking token", () => {
  it("issues a 256-bit base64url token (43 chars)", () => {
    expect(GUEST_TRACK_TOKEN_BYTES).toBe(32);
    const t = issueGuestTrackToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t).toHaveLength(43); // 32 bytes → 43 base64url chars
  });

  it("issues unique tokens", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(issueGuestTrackToken());
    expect(seen.size).toBe(1000);
  });

  it("accepts its own issued tokens as well-formed", () => {
    expect(isWellFormedTrackToken(issueGuestTrackToken())).toBe(true);
  });

  it("rejects malformed tokens", () => {
    expect(isWellFormedTrackToken("")).toBe(false);
    expect(isWellFormedTrackToken("short")).toBe(false);
    expect(isWellFormedTrackToken("a".repeat(19))).toBe(false);
    expect(isWellFormedTrackToken("a".repeat(65))).toBe(false);
    expect(isWellFormedTrackToken("has space")).toBe(false);
    expect(isWellFormedTrackToken("has/slash+plus=")).toBe(false);
  });

  it("stays compatible with legacy UUID-format tokens", () => {
    // Pre-existing orders carried a v4 UUID token; those links must keep working.
    expect(isWellFormedTrackToken("a3f8c2d1-4b5e-47f2-9c1d-8e2a1b3c4d5e")).toBe(
      true,
    );
  });
});

describe("clientIpFromXff", () => {
  it("extracts the left-most XFF hop, falling back to 'unknown'", () => {
    expect(clientIpFromXff("1.2.3.4, 5.6.7.8")).toBe("1.2.3.4");
    expect(clientIpFromXff("  9.9.9.9 ")).toBe("9.9.9.9");
    expect(clientIpFromXff(undefined)).toBe("unknown");
    expect(clientIpFromXff("")).toBe("unknown");
  });
});
