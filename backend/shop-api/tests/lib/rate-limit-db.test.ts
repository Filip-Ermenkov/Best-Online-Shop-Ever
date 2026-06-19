import { type DbClient } from "@shop/db";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "../../src/lib/db.js";
import { createDbRateLimiter } from "../../src/lib/rate-limit-db.js";

/**
 * Integration coverage for the distributed (Postgres-backed) rate limiter.
 *
 * The point of this limiter is that it holds CLUSTER-WIDE — the property the old
 * in-memory `Map` limiter could not provide on Lambda, where each warm container
 * had its own counter. The load-bearing test here is "two independent limiter
 * instances share one budget": two `createDbRateLimiter(...)` objects stand in
 * for two Lambda containers, and because they count in the same table the
 * combined ceiling is the configured limit, not 2× it.
 *
 * Runs against the real `shop_test` Postgres (migrated in global-setup, the
 * `rate_limit_counters` table truncated per-test in per-test.ts).
 */

const HOUR = 60 * 60 * 1000;

/** Read the stored counter for a (bucket, subject) — null if no row. */
async function storedCount(
  db: DbClient,
  bucket: string,
  subject: string,
): Promise<number | null> {
  const r = await db.execute(sql`
    SELECT count FROM rate_limit_counters
    WHERE bucket = ${bucket} AND subject = ${subject}
    ORDER BY window_start DESC
    LIMIT 1
  `);
  const rows = Array.isArray(r)
    ? r
    : ((r as { rows?: unknown[] }).rows ?? []);
  const row = rows[0] as { count: number | string } | undefined;
  return row ? Number(row.count) : null;
}

describe("distributed rate limiter (Postgres-backed)", () => {
  it("allows up to the limit then blocks within the same window", async () => {
    let clock = Date.parse("2026-06-19T10:00:00.000Z");
    const rl = createDbRateLimiter({
      bucket: "test_basic",
      limit: 3,
      windowMs: HOUR,
      now: () => clock,
    });

    const r1 = await rl.hit("1.1.1.1");
    const r2 = await rl.hit("1.1.1.1");
    const r3 = await rl.hit("1.1.1.1");
    const r4 = await rl.hit("1.1.1.1");

    expect(r1).toMatchObject({ allowed: true, remaining: 2 });
    expect(r2).toMatchObject({ allowed: true, remaining: 1 });
    expect(r3).toMatchObject({ allowed: true, remaining: 0 });
    expect(r4).toMatchObject({ allowed: false, remaining: 0 });
    // resetAt is the end of the aligned window.
    expect(r1.resetAt).toBe(Math.floor(clock / HOUR) * HOUR + HOUR);
  });

  it("enforces ONE budget across two independent limiter instances (cluster-wide)", async () => {
    const clock = Date.parse("2026-06-19T10:00:00.000Z");
    // Two separate objects = two Lambda containers sharing the same Postgres.
    const containerA = createDbRateLimiter({
      bucket: "test_shared",
      limit: 3,
      windowMs: HOUR,
      now: () => clock,
    });
    const containerB = createDbRateLimiter({
      bucket: "test_shared",
      limit: 3,
      windowMs: HOUR,
      now: () => clock,
    });

    expect((await containerA.hit("9.9.9.9")).allowed).toBe(true); // 1
    expect((await containerB.hit("9.9.9.9")).allowed).toBe(true); // 2
    expect((await containerA.hit("9.9.9.9")).allowed).toBe(true); // 3
    // The 4th hit lands on B — the in-memory limiter would have allowed it
    // (B's own Map would only have seen 1 prior hit); the DB limiter blocks it.
    expect((await containerB.hit("9.9.9.9")).allowed).toBe(false); // 4 → blocked
  });

  it("does not increment the stored counter past the limit on a blocked hit", async () => {
    const db = getDb();
    const clock = Date.parse("2026-06-19T10:00:00.000Z");
    const rl = createDbRateLimiter({
      bucket: "test_noinc",
      limit: 2,
      windowMs: HOUR,
      now: () => clock,
    });

    await rl.hit("5.5.5.5"); // 1
    await rl.hit("5.5.5.5"); // 2 (at limit)
    await rl.hit("5.5.5.5"); // blocked — must NOT write a 3
    await rl.hit("5.5.5.5"); // blocked again

    expect(await storedCount(db, "test_noinc", "5.5.5.5")).toBe(2);
  });

  it("resets the budget when the fixed window rolls", async () => {
    let clock = Date.parse("2026-06-19T10:30:00.000Z");
    const rl = createDbRateLimiter({
      bucket: "test_roll",
      limit: 1,
      windowMs: HOUR,
      now: () => clock,
    });

    expect((await rl.hit("1.2.3.4")).allowed).toBe(true);
    expect((await rl.hit("1.2.3.4")).allowed).toBe(false);

    clock += HOUR; // cross into the next aligned window
    expect((await rl.hit("1.2.3.4")).allowed).toBe(true);
  });

  it("isolates distinct subjects within a bucket", async () => {
    const clock = Date.parse("2026-06-19T10:00:00.000Z");
    const rl = createDbRateLimiter({
      bucket: "test_iso",
      limit: 1,
      windowMs: HOUR,
      now: () => clock,
    });

    expect((await rl.hit("a")).allowed).toBe(true);
    expect((await rl.hit("a")).allowed).toBe(false);
    expect((await rl.hit("b")).allowed).toBe(true); // independent subject
  });

  it("fails OPEN when the database errors (a limiter fault must not block traffic)", async () => {
    const throwingDb = {
      execute: async () => {
        throw new Error("simulated DB outage");
      },
    } as unknown as DbClient;

    const rl = createDbRateLimiter({
      bucket: "test_failopen",
      limit: 1,
      windowMs: HOUR,
      db: () => throwingDb,
    });

    const r = await rl.hit("1.1.1.1");
    expect(r.allowed).toBe(true); // fail-open
  });
});
