import { schema } from "@shop/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  runCatalogBackupJob,
  type PutObjectInput,
} from "../../src/jobs/catalog-backup.js";
import { runJob } from "../../src/jobs/runner.js";
import { handler } from "../../src/jobs/handler.js";
import { getDb } from "../../src/lib/db.js";
import { _resetEnvForTests } from "../../src/lib/env.js";
import { seedCategory, seedImage, seedProduct } from "../fixtures.js";

/**
 * The daily catalog backup (src/jobs/catalog-backup.ts) — exercised through
 * an injected putObject recorder (same DI posture as the email stub), plus
 * the runner/Lambda-handler dispatch contract.
 */

// 22:30 UTC on 12 June is 01:30 on 13 June in Sofia (EEST, UTC+3) — the
// date stamp must follow the SHOP's calendar, not the UTC one.
const NOW = new Date("2026-06-12T22:30:00Z");

function makeRecorder() {
  const puts: PutObjectInput[] = [];
  return {
    puts,
    putObject: async (input: PutObjectInput) => {
      puts.push(input);
    },
  };
}

beforeEach(() => {
  process.env.CATALOG_BACKUP_BUCKET = "test-catalog-backup";
  _resetEnvForTests();
});

afterEach(() => {
  delete process.env.CATALOG_BACKUP_BUCKET;
  _resetEnvForTests();
});

describe("runCatalogBackupJob", () => {
  it("throws loudly when the bucket is not configured (no silent no-op backups)", async () => {
    delete process.env.CATALOG_BACKUP_BUCKET;
    _resetEnvForTests();
    const { putObject } = makeRecorder();
    await expect(
      runCatalogBackupJob({ now: NOW, putObject }),
    ).rejects.toThrow(/CATALOG_BACKUP_BUCKET/);
  });

  it("writes a date-stamped (Sofia calendar) JSON envelope with every catalog table", async () => {
    const cat = await seedCategory({ slug: "instrumenti", name: "Инструменти" });
    const live = await seedProduct({
      slug: "perforator",
      code: "PRD-1",
      name: "Перфоратор",
      priceCents: 12_500,
      categoryId: cat.id,
    });
    const gone = await seedProduct({
      slug: "stara-bormashina",
      code: "PRD-2",
      name: "Стара бормашина",
      priceCents: 9_900,
      categoryId: cat.id,
    });
    // Soft-delete one product — full fidelity means it MUST be in the backup.
    const db = getDb();
    await db
      .update(schema.products)
      .set({ deletedAt: new Date("2026-06-01T00:00:00Z") })
      .where(eq(schema.products.id, gone.id));
    await seedImage({ productId: live.id, s3Key: "products/perforator-1.jpg" });

    const { puts, putObject } = makeRecorder();
    const result = await runCatalogBackupJob({ now: NOW, putObject });

    expect(puts).toHaveLength(1);
    const put = puts[0]!;
    expect(put.bucket).toBe("test-catalog-backup");
    expect(put.key).toBe("catalog/2026-06-13.json"); // Sofia date, not UTC
    expect(put.contentType).toBe("application/json");

    const envelope = JSON.parse(put.body) as {
      v: number;
      kind: string;
      takenAt: string;
      counts: Record<string, number>;
      tables: Record<string, Array<Record<string, unknown>>>;
    };
    expect(envelope.v).toBe(1);
    expect(envelope.kind).toBe("catalog-backup");
    expect(envelope.takenAt).toBe(NOW.toISOString());
    expect(envelope.counts).toEqual({
      categories: 1,
      products: 2,
      productImages: 1,
      bannerSlides: 0,
    });
    const slugs = envelope.tables.products!.map((p) => p.slug).sort();
    expect(slugs).toEqual(["perforator", "stara-bormashina"]);
    const softDeleted = envelope.tables.products!.find(
      (p) => p.slug === "stara-bormashina",
    );
    expect(softDeleted?.deletedAt).toBe("2026-06-01T00:00:00.000Z");

    expect(result.bucket).toBe("test-catalog-backup");
    expect(result.key).toBe("catalog/2026-06-13.json");
    expect(result.bytes).toBe(Buffer.byteLength(put.body, "utf8"));

    // The dormant catalog_backups table is now live: one 'scheduled' row per
    // snapshot, pointing at the uploaded key (ARCHITECTURE §12.3's index for
    // the future admin Archive/restore page).
    const rows = await db.select().from(schema.catalogBackups);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.s3Key).toBe("catalog/2026-06-13.json");
    expect(rows[0]!.kind).toBe("scheduled");
    expect(rows[0]!.triggeredByUserId).toBeNull();
    expect(rows[0]!.sizeBytes).toBe(String(result.bytes));
  });

  it("is byte-identical across same-day re-runs and keeps ONE catalog_backups row per key", async () => {
    await seedCategory({ slug: "krepezhi", name: "Крепежи" });
    const { puts, putObject } = makeRecorder();
    await runCatalogBackupJob({ now: NOW, putObject });
    await runCatalogBackupJob({ now: NOW, putObject });
    expect(puts).toHaveLength(2);
    expect(puts[0]!.key).toBe(puts[1]!.key);
    expect(puts[0]!.body).toBe(puts[1]!.body);

    const db = getDb();
    const rows = await db.select().from(schema.catalogBackups);
    expect(rows).toHaveLength(1); // replace-by-key, not append
  });

  it("writes a MANUAL snapshot to a timestamped key without clobbering the scheduled row", async () => {
    await seedCategory({ slug: "rachni", name: "Ръчни" });
    const db = getDb();
    // A manual backup is attributed to the admin who triggered it (FK to users).
    const [admin] = await db
      .insert(schema.users)
      .values({
        email: `manual-backup-${Date.now()}@shop.bg`,
        passwordHash: "x",
        role: "admin",
        accountType: null,
        emailVerifiedAt: new Date(),
      })
      .returning({ id: schema.users.id });

    const { puts, putObject } = makeRecorder();
    // A scheduled run (date-keyed) then a manual run (timestamped) on the SAME day.
    await runCatalogBackupJob({ now: NOW, putObject });
    const manual = await runCatalogBackupJob({
      now: NOW,
      putObject,
      kind: "manual",
      triggeredByUserId: admin!.id,
    });

    expect(manual.kind).toBe("manual");
    // Sofia wall-clock of 22:30Z on 12 Jun is 01:30 on 13 Jun (EEST).
    expect(manual.key).toBe("catalog/manual/2026-06-13_01-30-00.json");
    expect(manual.key).not.toBe("catalog/2026-06-13.json");
    expect(puts).toHaveLength(2);

    // Two distinct restore points — the manual insert does NOT replace the
    // scheduled row (replace-by-key is scheduled-only).
    const rows = await db.select().from(schema.catalogBackups);
    expect(rows).toHaveLength(2);
    const manualRow = rows.find((r) => r.kind === "manual");
    expect(manualRow?.s3Key).toBe("catalog/manual/2026-06-13_01-30-00.json");
    expect(manualRow?.triggeredByUserId).toBe(admin!.id);
  });
});

describe("jobs dispatch (runner + Lambda handler)", () => {
  it("runJob routes catalog-backup through the registry", async () => {
    // No putObject injection path through the runner — but the env guard
    // fires BEFORE any S3 client is constructed, so pointing the job at an
    // unconfigured bucket... is exactly the loud-failure contract:
    delete process.env.CATALOG_BACKUP_BUCKET;
    _resetEnvForTests();
    await expect(runJob("catalog-backup")).rejects.toThrow(
      /CATALOG_BACKUP_BUCKET/,
    );
  });

  it("the Lambda handler rejects unknown jobs loudly", async () => {
    await expect(handler({ job: "definitely-not-a-job" })).rejects.toThrow(
      /Invalid scheduler event/,
    );
    await expect(handler({})).rejects.toThrow(/Invalid scheduler event/);
    await expect(handler(null)).rejects.toThrow(/Invalid scheduler event/);
  });

  it("the Lambda handler runs a known job end-to-end", async () => {
    // pickup-expiry on an empty DB: a clean zero-work run.
    const result = await handler({ job: "pickup-expiry" });
    expect(result).toEqual({ claimed: 0, emailed: 0 });
  });
});
