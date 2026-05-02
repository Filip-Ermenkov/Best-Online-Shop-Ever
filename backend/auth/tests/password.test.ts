import { describe, expect, it } from "vitest";
import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  needsRehash,
  PASSWORD_HASH_OPTIONS,
  verifyPassword,
} from "../src/password.js";

describe("hashPassword / verifyPassword", () => {
  it("produces a PHC-format argon2id hash with the configured parameters", async () => {
    const hash = await hashPassword("CorrectHorseBattery3");
    // PHC format: $argon2id$v=19$m=19456,t=2,p=1$...
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).toContain(`m=${PASSWORD_HASH_OPTIONS.memoryCost}`);
    expect(hash).toContain(`t=${PASSWORD_HASH_OPTIONS.timeCost}`);
    expect(hash).toContain(`p=${PASSWORD_HASH_OPTIONS.parallelism}`);
  });

  it("verifies a correct password", async () => {
    const hash = await hashPassword("CorrectHorseBattery3");
    expect(await verifyPassword(hash, "CorrectHorseBattery3")).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("CorrectHorseBattery3");
    expect(await verifyPassword(hash, "WrongHorseBattery3")).toBe(false);
  });

  it("rejects garbage hash strings without throwing", async () => {
    expect(await verifyPassword("not-a-hash", "anything")).toBe(false);
    expect(await verifyPassword("", "anything")).toBe(false);
    expect(await verifyPassword("$argon2id$v=19$m=1$incomplete", "x")).toBe(
      false,
    );
  });

  it("hashes the same input to different output strings (random salt)", async () => {
    const a = await hashPassword("repeat-me");
    const b = await hashPassword("repeat-me");
    expect(a).not.toBe(b);
    // Both still verify against the same plaintext.
    expect(await verifyPassword(a, "repeat-me")).toBe(true);
    expect(await verifyPassword(b, "repeat-me")).toBe(true);
  });

  it("does NOT need rehash for hashes produced by the current params", async () => {
    const hash = await hashPassword("ParamCheck1");
    expect(needsRehash(hash)).toBe(false);
  });

  it("DOES need rehash for a hash with weaker parameters", () => {
    // Hand-crafted argon2id hash with m=8192 (8 MiB) — weaker than current.
    // Format is real but the hash bytes are arbitrary; needsRehash inspects
    // the params, not the hash bytes.
    const weaker =
      "$argon2id$v=19$m=8192,t=1,p=1$YWFhYWFhYWFhYWFhYWFhYQ$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    expect(needsRehash(weaker)).toBe(true);
  });

  it("treats malformed hashes as needsRehash=true (will re-hash on next login)", () => {
    expect(needsRehash("definitely-not-a-hash")).toBe(true);
    expect(needsRehash("")).toBe(true);
  });
});

describe("DUMMY_PASSWORD_HASH", () => {
  it("resolves to a valid argon2id hash that verifies negative against any guess", async () => {
    const dummy = await DUMMY_PASSWORD_HASH;
    expect(dummy).toMatch(/^\$argon2id\$/);
    // The dummy plaintext is unguessable; any guess MUST fail.
    expect(await verifyPassword(dummy, "")).toBe(false);
    expect(await verifyPassword(dummy, "password")).toBe(false);
    expect(await verifyPassword(dummy, "Password1!")).toBe(false);
  });
});
