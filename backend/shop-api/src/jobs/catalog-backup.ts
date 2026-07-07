import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { schema } from "@shop/db";
import { asc, eq } from "drizzle-orm";
import type { Logger } from "pino";
import { getDb } from "../lib/db.js";
import { parseEnv } from "../lib/env.js";

/**
 * Daily catalog backup (ARCHITECTURE §6.3): a full JSON export of the four
 * catalog tables to S3. Customer data is NOT here by design — Neon PITR is
 * the recovery story for transactional/PII data, while this artifact covers
 * the catalog (the one dataset the shop's owner curates by hand and cannot
 * re-derive), and doubles as the seed for DR drills (roadmap item 19).
 * Because it contains zero personal data, the GDPR backup-erasure tension
 * (deleted user still present in old backups) does not apply to it.
 *
 * Idempotency: the object key is the Sofia calendar date
 * (`<prefix>YYYY-MM-DD.json`), so an at-least-once duplicate run simply
 * overwrites the same key with the same content. Retention/versioning live
 * on the bucket (infra/scheduler.tf): versioned, 90-day expiry, SSE-KMS.
 *
 * Each successful upload is recorded in the dormant-since-0000
 * `catalog_backups` table ("one row per snapshot" — the admin Archive page
 * lists from it, ARCHITECTURE §12.3). A SCHEDULED run keeps the "one row per
 * Sofia day" invariant under re-runs by replacing the key's row in one
 * transaction (kind='scheduled', triggered_by_user_id=NULL). A MANUAL run
 * (admin-triggered from `POST /admin/archive/backup`, roadmap item 51) is
 * timestamped instead of date-keyed, so each click is its own distinct restore
 * point that never clobbers the day's scheduled snapshot — it always INSERTs a
 * fresh row (kind='manual', triggered_by_user_id=<admin>).
 *
 * Soft-deleted rows are INCLUDED (full fidelity — a restore must be able to
 * resurrect the deleted_at state and the redirects that point at it).
 *
 * The S3 client is injectable so tests exercise the job against a recorder
 * without an AWS dependency — same DI posture as the email transports.
 */

export interface CatalogBackupResult {
  bucket: string;
  key: string;
  bytes: number;
  kind: "scheduled" | "manual";
  counts: {
    categories: number;
    products: number;
    productImages: number;
    bannerSlides: number;
  };
}

export interface PutObjectInput {
  bucket: string;
  key: string;
  body: string;
  contentType: string;
}

export type PutObjectFn = (input: PutObjectInput) => Promise<void>;

let defaultClient: S3Client | null = null;

/** Production path: one lazily constructed S3Client per Lambda container. */
const s3PutObject: PutObjectFn = async (input) => {
  defaultClient ??= new S3Client({});
  await defaultClient.send(
    new PutObjectCommand({
      Bucket: input.bucket,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
    }),
  );
};

/** Sofia calendar date (YYYY-MM-DD) — en-CA renders ISO-style. */
function sofiaDateStamp(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: "Europe/Sofia" });
}

/** Sofia wall-clock stamp (YYYY-MM-DD_HH-mm-ss) for unique manual-backup keys. */
function sofiaDateTimeStamp(d: Date): string {
  // sv-SE renders ISO-like "YYYY-MM-DD HH:mm:ss"; make it S3-key-safe.
  return d
    .toLocaleString("sv-SE", { timeZone: "Europe/Sofia", hour12: false })
    .replace(" ", "_")
    .replaceAll(":", "-");
}

export async function runCatalogBackupJob(opts?: {
  now?: Date;
  logger?: Logger;
  putObject?: PutObjectFn;
  /** "scheduled" (daily cron, default) or "manual" (admin-triggered). */
  kind?: "scheduled" | "manual";
  /** For manual runs: the admin who triggered it (audit provenance). */
  triggeredByUserId?: string | null;
}): Promise<CatalogBackupResult> {
  const env = parseEnv();
  if (env.CATALOG_BACKUP_BUCKET.length === 0) {
    // Throw (→ Lambda Errors alarm) instead of a silent no-op: a deployed
    // backup job that quietly backs up nothing is the worst failure mode a
    // backup can have.
    throw new Error(
      "CATALOG_BACKUP_BUCKET is required for the catalog-backup job",
    );
  }

  const db = getDb();
  const now = opts?.now ?? new Date();
  const putObject = opts?.putObject ?? s3PutObject;
  const kind = opts?.kind ?? "scheduled";
  const triggeredByUserId = opts?.triggeredByUserId ?? null;

  // Deterministic ordering keeps same-day re-runs byte-identical, which
  // makes bucket versioning meaningful (a new version ⇒ the catalog really
  // changed between runs).
  const [categories, products, productImages, bannerSlides] = await Promise.all([
    db.select().from(schema.categories).orderBy(asc(schema.categories.id)),
    db.select().from(schema.products).orderBy(asc(schema.products.id)),
    db.select().from(schema.productImages).orderBy(asc(schema.productImages.id)),
    db.select().from(schema.bannerSlides).orderBy(asc(schema.bannerSlides.id)),
  ]);

  const envelope = {
    v: 1 as const,
    kind: "catalog-backup" as const,
    takenAt: now.toISOString(),
    counts: {
      categories: categories.length,
      products: products.length,
      productImages: productImages.length,
      bannerSlides: bannerSlides.length,
    },
    tables: { categories, products, productImages, bannerSlides },
  };

  const body = JSON.stringify(envelope);
  // Scheduled: one idempotent date-keyed snapshot per Sofia day. Manual: a
  // timestamped key under `manual/` so each admin click is a distinct restore
  // point that never overwrites the day's scheduled backup.
  const key =
    kind === "manual"
      ? `${env.CATALOG_BACKUP_PREFIX}manual/${sofiaDateTimeStamp(now)}.json`
      : `${env.CATALOG_BACKUP_PREFIX}${sofiaDateStamp(now)}.json`;

  await putObject({
    bucket: env.CATALOG_BACKUP_BUCKET,
    key,
    body,
    contentType: "application/json",
  });

  const bytes = Buffer.byteLength(body, "utf8");

  // Record the snapshot in catalog_backups AFTER the object exists (a row
  // must never point at a missing object; an object without a row just gets
  // re-rowed by the next run). Replace-by-key keeps the "one row per
  // snapshot" invariant across same-day re-runs.
  await db.transaction(async (tx) => {
    // Scheduled runs replace the day's row (idempotent re-run); manual runs are
    // distinct restore points, so they always insert a fresh row.
    if (kind === "scheduled") {
      await tx
        .delete(schema.catalogBackups)
        .where(eq(schema.catalogBackups.s3Key, key));
    }
    await tx.insert(schema.catalogBackups).values({
      s3Key: key,
      kind,
      triggeredByUserId,
      sizeBytes: String(bytes),
    });
  });

  const result: CatalogBackupResult = {
    bucket: env.CATALOG_BACKUP_BUCKET,
    key,
    bytes,
    kind,
    counts: envelope.counts,
  };
  opts?.logger?.info(result, "catalog_backup_written");
  return result;
}

/** Test-only: drop the cached S3 client. */
export function _resetS3ClientForTests(): void {
  defaultClient = null;
}
