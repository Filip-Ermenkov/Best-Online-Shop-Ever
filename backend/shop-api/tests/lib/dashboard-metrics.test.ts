import { describe, expect, it } from "vitest";
import {
  averageOrderValueCents,
  buildDaySeries,
  sofiaDate,
} from "../../src/lib/dashboard-metrics.js";

/**
 * Pure unit tests for the dashboard helpers (no DB). The integration behaviour
 * (SQL aggregates, Sofia bounds) is covered in tests/routes/admin-dashboard.test.ts.
 */

describe("buildDaySeries", () => {
  it("returns exactly `days` dense points, oldest → newest", () => {
    const s = buildDaySeries("2026-07-06", 14, []);
    expect(s).toHaveLength(14);
    expect(s[0]!.date).toBe("2026-06-23");
    expect(s[13]!.date).toBe("2026-07-06");
  });

  it("zero-fills days with no rows and fills days that have them", () => {
    const s = buildDaySeries("2026-07-06", 14, [
      { date: "2026-07-06", orders: 3, revenueCents: 15000 },
      { date: "2026-07-01", orders: 1, revenueCents: 5000 },
    ]);
    expect(s[13]).toEqual({ date: "2026-07-06", orders: 3, revenueCents: 15000 });
    expect(s.find((p) => p.date === "2026-07-01")).toEqual({
      date: "2026-07-01",
      orders: 1,
      revenueCents: 5000,
    });
    // A day with no row is present with zeros.
    expect(s.find((p) => p.date === "2026-07-02")).toEqual({
      date: "2026-07-02",
      orders: 0,
      revenueCents: 0,
    });
  });

  it("ignores a row whose date is not on the generated axis", () => {
    const s = buildDaySeries("2026-07-06", 3, [
      { date: "2020-01-01", orders: 9, revenueCents: 9 },
    ]);
    expect(s.every((p) => p.orders === 0 && p.revenueCents === 0)).toBe(true);
  });

  it("spans month boundaries with correct calendar arithmetic", () => {
    const s = buildDaySeries("2026-07-02", 5, []);
    expect(s.map((p) => p.date)).toEqual([
      "2026-06-28",
      "2026-06-29",
      "2026-06-30",
      "2026-07-01",
      "2026-07-02",
    ]);
  });
});

describe("averageOrderValueCents", () => {
  it("divides revenue by the order count", () => {
    expect(averageOrderValueCents(15000, 3)).toBe(5000);
  });

  it("rounds to the nearest cent", () => {
    expect(averageOrderValueCents(10000, 3)).toBe(3333);
  });

  it("returns 0 for zero or negative order counts (no divide-by-zero)", () => {
    expect(averageOrderValueCents(0, 0)).toBe(0);
    expect(averageOrderValueCents(500, -1)).toBe(0);
  });
});

describe("sofiaDate", () => {
  it("formats an instant as a Europe/Sofia YYYY-MM-DD date", () => {
    expect(sofiaDate(new Date("2026-07-06T10:00:00Z"))).toBe("2026-07-06");
  });

  it("rolls into the next Sofia day for a late-evening UTC instant (UTC+3 summer)", () => {
    expect(sofiaDate(new Date("2026-07-06T23:30:00Z"))).toBe("2026-07-07");
  });
});
