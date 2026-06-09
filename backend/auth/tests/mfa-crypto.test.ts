import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  generateMfaKeyBase64,
  loadMfaKey,
} from "../src/mfa-crypto.js";

describe("loadMfaKey", () => {
  it("accepts a valid 32-byte Base64 key", () => {
    const key = loadMfaKey(generateMfaKeyBase64());
    expect(key).toHaveLength(32);
  });

  it("rejects a missing key", () => {
    expect(() => loadMfaKey(undefined)).toThrow(/not configured/);
    expect(() => loadMfaKey("")).toThrow(/not configured/);
  });

  it("rejects a key of the wrong length", () => {
    expect(() => loadMfaKey(Buffer.alloc(16).toString("base64"))).toThrow(
      /must be 32 bytes/,
    );
  });
});

describe("encryptSecret / decryptSecret (AES-256-GCM)", () => {
  const key = loadMfaKey(generateMfaKeyBase64());
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  it("round-trips a secret", () => {
    const payload = encryptSecret(secret, key);
    expect(decryptSecret(payload, key)).toBe(secret);
  });

  it("emits the versioned 4-part wire format", () => {
    const payload = encryptSecret(secret, key);
    const parts = payload.split(":");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
  });

  it("produces a different ciphertext each time (random IV)", () => {
    expect(encryptSecret(secret, key)).not.toBe(encryptSecret(secret, key));
  });

  it("fails to decrypt with the wrong key", () => {
    const payload = encryptSecret(secret, key);
    const otherKey = loadMfaKey(generateMfaKeyBase64());
    expect(() => decryptSecret(payload, otherKey)).toThrow();
  });

  it("fails to decrypt a tampered ciphertext (GCM auth tag)", () => {
    const payload = encryptSecret(secret, key);
    const parts = payload.split(":");
    // Flip a byte in the ciphertext.
    const ct = Buffer.from(parts[3]!, "base64");
    ct[0] = ct[0]! ^ 0xff;
    parts[3] = ct.toString("base64");
    expect(() => decryptSecret(parts.join(":"), key)).toThrow();
  });

  it("rejects an unrecognised format", () => {
    expect(() => decryptSecret("v2:a:b:c", key)).toThrow(/Unrecognised/);
    expect(() => decryptSecret("garbage", key)).toThrow(/Unrecognised/);
  });
});
