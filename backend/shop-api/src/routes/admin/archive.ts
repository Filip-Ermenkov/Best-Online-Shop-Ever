import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { schema } from "@shop/db";
import { and, desc, eq, inArray, isNotNull, isNull, notInArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Logger } from "pino";
import {
  runCatalogBackupJob,
  type CatalogBackupResult,
} from "../../jobs/catalog-backup.js";
import {
  parseCatalogSnapshot,
  planCatalogRestore,
  orderCategoriesParentFirst,
  SnapshotFormatError,
  type CatalogSnapshot,
} from "../../lib/catalog-restore.js";
import {
  ancestorSlugChain,
  categoryUrlFromChain,
  type CatRow,
} from "../../lib/category-tree.js";
import { getDb } from "../../lib/db.js";
import { parseEnv } from "../../lib/env.js";
import { ApiError, ProblemSchema } from "../../lib/errors.js";
import { logger as baseLogger } from "../../lib/logger.js";
import { productCanonicalPath } from "../../lib/product-admin.js";
import { validationHook } from "../../lib/validation-hook.js";
import { requireAdmin } from "../../middleware/admin.js";
import type { AuthVariables } from "../../middleware/auth.js";

/**
 * Admin archive — the recovery surface (docs/README.md §12 „Архивиране и
 * възстановяване"; §"Архивиране от панела"). The LAST admin screen that still
 * rendered mock data; this slice (roadmap item 51) un-mocks it and, with the
 * dashboard slice, makes the entire admin panel real.
 *
 * Surface (all behind `requireAdmin` — non-admins get the uniform 404):
 *
 *   GET  /admin/archive                       soft-deleted products + categories + backups
 *   POST /admin/archive/backup                trigger an on-demand ("manual") catalog backup
 *   GET  /admin/archive/backups/:id/preview   dry-run diff of restoring a snapshot
 *   POST /admin/archive/backups/:id/restore   replay a snapshot over the live catalog
 *
 * (PER-ITEM restore lives with its entity — `POST /admin/products/:id/restore`
 * and `POST /admin/categories/:id/restore` — so the archive UI simply calls
 * those; keeping restore beside the CRUD it reverses is the established pattern
 * and avoids a second writer of the same tables. SNAPSHOT restore is different —
 * it spans all four catalog tables at once, so it belongs here.)
 *
 * Design notes (researched against 2026 practice — see ARCHITECTURE §13):
 *
 *   - **Two recovery mechanisms, honestly separated.** Modern "trash/restore"
 *     guidance is to give admins a view of soft-deleted rows with an explicit
 *     per-item restore, kept distinct from harder destructive operations. This
 *     page shows exactly that (the `deleted_at` rows) PLUS the point-in-time
 *     catalog snapshots the scheduler writes. Restoring an INDIVIDUAL archived
 *     product/category is the safe, reversible 80%; restoring a WHOLE snapshot
 *     over the live catalog (roadmap item 52) is the high-blast-radius 20% — so
 *     it is gated behind a dry-run **preview** (what will change / what will be
 *     archived), a typed **confirmation**, and an automatic **pre-restore safety
 *     backup** (the "tail-log backup before restore" rule), then applied in a
 *     single transaction. Rows created after the snapshot are SOFT-deleted
 *     (reversible), never hard-deleted; see `lib/catalog-restore.ts`.
 *
 *   - **On-demand backups alongside scheduled ones.** 2026 backup guidance
 *     treats an operator-triggered snapshot as a first-class complement to the
 *     daily cron (an extra restore point before a risky bulk edit). The manual
 *     run reuses the exact catalog-backup job — timestamped key, its own
 *     `catalog_backups` row (kind='manual') — so scheduled and manual snapshots
 *     are the same artifact and list identically.
 *
 *   - **Read-only surface carries no PII.** Categories, products, and catalog
 *     backups hold zero personal data, so viewing this page is a plain info log
 *     — NOT an `admin_customer_viewed`-style PII-read event. The manual backup
 *     IS a state change, so it writes an `admin_audit_log` row (GDPR Art. 30).
 *
 *   - **Degrades cleanly when unconfigured.** The manual-backup route returns a
 *     clean `503 /problems/backups-not-configured` when no backup bucket is set
 *     (mirroring `/admin/uploads`), and the overview advertises `backupsAvailable`
 *     so the UI can disable the button with an explanation rather than fail on click.
 */

type AdminArchiveVariables = AuthVariables & {
  logger: Logger;
  requestId: string;
};

export const adminArchiveRoutes = new OpenAPIHono<{
  Variables: AdminArchiveVariables;
}>({
  defaultHook: validationHook,
});

// currentUser runs in app.ts; requireAdmin collapses the surface to a flat 404
// for non-admins — uniform with the rest of the admin API.
adminArchiveRoutes.use("*", requireAdmin);

// Archive lists are admin-only and rare; cap them so a pathological catalog can
// never return an unbounded payload. A small shop will never approach these.
const ARCHIVE_LIST_CAP = 100;
const BACKUPS_CAP = 60;

// ─── AWS adapters (injectable — same DI posture as the uploads S3 adapters) ────
//
// Two AWS touchpoints live on this route: the manual catalog backup (a write)
// and the snapshot read for restore/preview (a read). Both are swappable so the
// integration tests exercise the full wiring (requireAdmin, the gates, the audit
// row, the transactional replay) without AWS creds; the real S3 calls are proven
// by the catalog-backup job's own tests and, for the read, by a live drill.

export type BackupRunnerFn = (opts: {
  kind: "manual";
  triggeredByUserId: string;
  logger?: Logger;
}) => Promise<CatalogBackupResult>;

/** Fetch a backup object's body as a UTF-8 string. */
export type GetObjectFn = (opts: { bucket: string; key: string }) => Promise<string>;

let backupRunner: BackupRunnerFn = (opts) => runCatalogBackupJob(opts);

let s3ReadClient: S3Client | null = null;
const defaultGetObject: GetObjectFn = async ({ bucket, key }) => {
  s3ReadClient ??= new S3Client({});
  const res = await s3ReadClient.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  if (!res.Body) throw new Error(`empty S3 body for ${key}`);
  return res.Body.transformToString("utf-8");
};
let getObject: GetObjectFn = defaultGetObject;

/** Test seam: override the backup runner and/or the snapshot reader. */
export function _setArchiveAdaptersForTests(a: {
  backupRunner?: BackupRunnerFn;
  getObject?: GetObjectFn;
}): void {
  if (a.backupRunner) backupRunner = a.backupRunner;
  if (a.getObject) getObject = a.getObject;
}
export function _resetArchiveAdaptersForTests(): void {
  backupRunner = (opts) => runCatalogBackupJob(opts);
  getObject = defaultGetObject;
}

// ─── DTOs ────────────────────────────────────────────────────────────────────

const ArchivedProductSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    code: z.string(),
    /** The category it belonged to (may itself be archived), for context. */
    categoryName: z.string().nullable(),
    deletedAt: z.string(),
  })
  .openapi("AdminArchivedProduct");

const ArchivedCategorySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
    parentName: z.string().nullable(),
    deletedAt: z.string(),
  })
  .openapi("AdminArchivedCategory");

const CatalogBackupSchema = z
  .object({
    id: z.string().uuid(),
    /** "scheduled" (daily cron) or "manual" (admin-triggered). */
    kind: z.enum(["scheduled", "manual"]),
    /** Snapshot size in bytes; null for legacy rows written without it. */
    sizeBytes: z.number().int().nullable(),
    createdAt: z.string(),
  })
  .openapi("AdminCatalogBackup");

const ArchiveOverviewSchema = z
  .object({
    archivedProducts: z.array(ArchivedProductSchema),
    archivedCategories: z.array(ArchivedCategorySchema),
    /** Point-in-time catalog snapshots, newest first. */
    backups: z.array(CatalogBackupSchema),
    /** Whether a backup bucket is configured — gates the manual-backup button. */
    backupsAvailable: z.boolean(),
  })
  .openapi("AdminArchiveOverview");

export type ArchiveOverview = z.infer<typeof ArchiveOverviewSchema>;

const ManualBackupResultSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.literal("manual"),
    sizeBytes: z.number().int(),
    createdAt: z.string(),
  })
  .openapi("AdminManualBackupResult");

export type ManualBackupResult = z.infer<typeof ManualBackupResultSchema>;

function backupsNotConfigured(): ApiError {
  return new ApiError({
    type: "/problems/backups-not-configured",
    title: "Backups Not Configured",
    status: 503,
    detail:
      "Manual catalog backup is unavailable: no backup bucket is configured for this deployment.",
  });
}

function backupFailed(): ApiError {
  return new ApiError({
    type: "/problems/backup-failed",
    title: "Backup Failed",
    status: 502,
    detail:
      "The catalog backup could not be completed. Check the backup storage and try again.",
  });
}

// ─── Snapshot restore (roadmap item 52) ───────────────────────────────────────
//
// The typed confirmation the destructive restore requires, mirroring the account
// deletion's „ИЗТРИЙ" gate. Enforced server-side too (defence in depth) — the UI
// text and this constant must match. Cyrillic letters only (no curly quotes), so
// it is safe inside a double-quoted TS string.
const RESTORE_CONFIRMATION = "ВЪЗСТАНОВИ";

const RestorePlanSchema = z
  .object({
    /** When the snapshot was taken (its `takenAt`). */
    takenAt: z.string(),
    /** Row counts the snapshot restores the catalog to. */
    counts: z.object({
      categories: z.number().int(),
      products: z.number().int(),
      productImages: z.number().int(),
      bannerSlides: z.number().int(),
    }),
    /** The destructive impact: live rows absent from the snapshot get archived. */
    willArchive: z.object({
      productCount: z.number().int(),
      categoryCount: z.number().int(),
      productNames: z.array(z.string()),
      categoryNames: z.array(z.string()),
    }),
    /** Live banners the full-replace drops before re-inserting the snapshot's. */
    liveBannerCount: z.number().int(),
  })
  .openapi("AdminCatalogRestorePlan");

export type CatalogRestorePlan = z.infer<typeof RestorePlanSchema>;

const RestoreRequestSchema = z
  .object({
    /** Must equal `RESTORE_CONFIRMATION` — the typed „ВЪЗСТАНОВИ" gate. */
    confirm: z.string(),
  })
  .openapi("AdminCatalogRestoreRequest");

const RestoreResultSchema = z
  .object({
    /** The plan that was applied (echoes the preview). */
    restored: RestorePlanSchema,
    /** The auto-taken pre-restore safety backup (the rollback point). */
    safetyBackupId: z.string().uuid(),
    safetyBackupCreatedAt: z.string(),
  })
  .openapi("AdminCatalogRestoreResult");

export type CatalogRestoreResult = z.infer<typeof RestoreResultSchema>;

function backupNotFound(): ApiError {
  return new ApiError({
    type: "/problems/backup-not-found",
    title: "Backup Not Found",
    status: 404,
    detail: "No catalog backup exists with that id (it may have been pruned).",
  });
}

function snapshotReadFailed(): ApiError {
  return new ApiError({
    type: "/problems/snapshot-read-failed",
    title: "Snapshot Read Failed",
    status: 502,
    detail: "The backup snapshot could not be read from storage. Try again shortly.",
  });
}

function snapshotInvalid(): ApiError {
  return new ApiError({
    type: "/problems/snapshot-invalid",
    title: "Snapshot Invalid",
    status: 422,
    detail: "The stored backup is not a valid catalog snapshot and cannot be restored.",
  });
}

function restoreConfirmationRequired(): ApiError {
  return new ApiError({
    type: "/problems/restore-confirmation-required",
    title: "Restore Confirmation Required",
    status: 400,
    detail: `To restore a snapshot over the live catalog, confirm by sending "${RESTORE_CONFIRMATION}".`,
  });
}

/** Look up a backup row's S3 key by id (shared by preview + restore). */
async function findBackupKey(id: string): Promise<string | null> {
  const db = getDb();
  const [row] = await db
    .select({ s3Key: schema.catalogBackups.s3Key })
    .from(schema.catalogBackups)
    .where(eq(schema.catalogBackups.id, id))
    .limit(1);
  return row?.s3Key ?? null;
}

/** Read + validate a snapshot from S3, mapping storage/format faults to 502/422. */
async function loadSnapshot(bucket: string, key: string): Promise<CatalogSnapshot> {
  let body: string;
  try {
    body = await getObject({ bucket, key });
  } catch {
    throw snapshotReadFailed();
  }
  try {
    return parseCatalogSnapshot(JSON.parse(body));
  } catch (err) {
    if (err instanceof SnapshotFormatError || err instanceof SyntaxError) {
      throw snapshotInvalid();
    }
    throw err;
  }
}

/** Project the current catalog into the shape `planCatalogRestore` needs. */
async function loadLiveStateForPlan(): Promise<{
  categories: { id: string; name: string; deletedAt: Date | null }[];
  products: { id: string; name: string; deletedAt: Date | null }[];
  bannerCount: number;
}> {
  const db = getDb();
  const [categories, products, banners] = await Promise.all([
    db
      .select({
        id: schema.categories.id,
        name: schema.categories.name,
        deletedAt: schema.categories.deletedAt,
      })
      .from(schema.categories),
    db
      .select({
        id: schema.products.id,
        name: schema.products.name,
        deletedAt: schema.products.deletedAt,
      })
      .from(schema.products),
    db.select({ id: schema.bannerSlides.id }).from(schema.bannerSlides),
  ]);
  return { categories, products, bannerCount: banners.length };
}

// ─── GET /admin/archive ───────────────────────────────────────────────────────

const overviewRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["admin-archive"],
  summary: "Soft-deleted products + categories awaiting restore, and the backups list",
  responses: {
    200: {
      description: "The archive overview.",
      content: { "application/json": { schema: ArchiveOverviewSchema } },
    },
    404: {
      description: "No admin session (uniform with the rest of the surface).",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminArchiveRoutes.openapi(overviewRoute, async (c) => {
  const db = getDb();
  const admin = c.get("user")!;
  const log = c.get("logger") ?? baseLogger;
  const env = parseEnv();

  const parent = alias(schema.categories, "parent_category");

  const [archivedProducts, archivedCategories, backups] = await Promise.all([
    db
      .select({
        id: schema.products.id,
        name: schema.products.name,
        code: schema.products.code,
        categoryName: schema.categories.name,
        deletedAt: schema.products.deletedAt,
      })
      .from(schema.products)
      .leftJoin(schema.categories, eq(schema.categories.id, schema.products.categoryId))
      .where(isNotNull(schema.products.deletedAt))
      .orderBy(desc(schema.products.deletedAt))
      .limit(ARCHIVE_LIST_CAP),
    db
      .select({
        id: schema.categories.id,
        name: schema.categories.name,
        slug: schema.categories.slug,
        parentName: parent.name,
        deletedAt: schema.categories.deletedAt,
      })
      .from(schema.categories)
      .leftJoin(parent, eq(parent.id, schema.categories.parentId))
      .where(isNotNull(schema.categories.deletedAt))
      .orderBy(desc(schema.categories.deletedAt))
      .limit(ARCHIVE_LIST_CAP),
    db
      .select({
        id: schema.catalogBackups.id,
        kind: schema.catalogBackups.kind,
        sizeBytes: schema.catalogBackups.sizeBytes,
        createdAt: schema.catalogBackups.createdAt,
      })
      .from(schema.catalogBackups)
      .orderBy(desc(schema.catalogBackups.createdAt))
      .limit(BACKUPS_CAP),
  ]);

  // No PII on this surface (catalog + backups only) — a plain read log.
  log.info({ event: "admin_archive_viewed", adminId: admin.id }, "admin_archive_viewed");

  return c.json(
    {
      archivedProducts: archivedProducts.map((r) => ({
        id: r.id,
        name: r.name,
        code: r.code,
        categoryName: r.categoryName,
        deletedAt: r.deletedAt!.toISOString(),
      })),
      archivedCategories: archivedCategories.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        parentName: r.parentName,
        deletedAt: r.deletedAt!.toISOString(),
      })),
      backups: backups.map((r) => ({
        id: r.id,
        kind: r.kind,
        sizeBytes: r.sizeBytes === null ? null : Number(r.sizeBytes),
        createdAt: r.createdAt.toISOString(),
      })),
      backupsAvailable: env.CATALOG_BACKUP_BUCKET.length > 0,
    },
    200,
  );
});

// ─── POST /admin/archive/backup ───────────────────────────────────────────────

const backupRoute = createRoute({
  method: "post",
  path: "/backup",
  tags: ["admin-archive"],
  summary: "Trigger an on-demand catalog backup (the spec's one-button manual archive)",
  responses: {
    201: {
      description: "The manual backup that was written.",
      content: { "application/json": { schema: ManualBackupResultSchema } },
    },
    404: {
      description: "No admin session (uniform with the rest of the surface).",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    502: {
      description: "`/problems/backup-failed` — the snapshot could not be written.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    503: {
      description: "`/problems/backups-not-configured` — no backup bucket set.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminArchiveRoutes.openapi(backupRoute, async (c) => {
  const db = getDb();
  const admin = c.get("user")!;
  const log = c.get("logger") ?? baseLogger;
  const env = parseEnv();

  if (env.CATALOG_BACKUP_BUCKET.length === 0) throw backupsNotConfigured();

  let result: CatalogBackupResult;
  try {
    result = await backupRunner({
      kind: "manual",
      triggeredByUserId: admin.id,
      logger: log,
    });
  } catch (err) {
    log.error({ err, adminId: admin.id }, "manual_backup_failed");
    throw backupFailed();
  }

  // The job wrote the catalog_backups row; read it back for its id + createdAt.
  const [row] = await db
    .select({
      id: schema.catalogBackups.id,
      createdAt: schema.catalogBackups.createdAt,
    })
    .from(schema.catalogBackups)
    .where(eq(schema.catalogBackups.s3Key, result.key))
    .orderBy(desc(schema.catalogBackups.createdAt))
    .limit(1);
  if (!row) throw backupFailed();

  // A manual backup is a state-changing admin action → audit it (GDPR Art. 30).
  await db.insert(schema.adminAuditLog).values({
    actorUserId: admin.id,
    action: "backup.create",
    entityTable: "catalog_backups",
    entityId: row.id,
    changes: { key: result.key, bytes: result.bytes, kind: "manual" },
    userAgent: c.req.header("user-agent") ?? null,
  });

  log.info(
    { adminId: admin.id, key: result.key, bytes: result.bytes },
    "manual_backup_created",
  );

  return c.json(
    {
      id: row.id,
      kind: "manual" as const,
      sizeBytes: result.bytes,
      createdAt: row.createdAt.toISOString(),
    },
    201,
  );
});

// ─── GET /admin/archive/backups/{id}/preview ──────────────────────────────────

const previewRoute = createRoute({
  method: "get",
  path: "/backups/{id}/preview",
  tags: ["admin-archive"],
  summary: "Dry-run: what restoring this snapshot over the live catalog would do",
  request: { params: z.object({ id: z.string().uuid() }) },
  responses: {
    200: {
      description: "The restore plan — a side-effect-free diff.",
      content: { "application/json": { schema: RestorePlanSchema } },
    },
    404: {
      description: "No admin session, or no backup with that id.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    422: {
      description: "`/problems/snapshot-invalid` — the stored object is not a valid snapshot.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    502: {
      description: "`/problems/snapshot-read-failed` — the snapshot could not be read.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    503: {
      description: "`/problems/backups-not-configured` — no backup bucket set.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminArchiveRoutes.openapi(previewRoute, async (c) => {
  const admin = c.get("user")!;
  const log = c.get("logger") ?? baseLogger;
  const env = parseEnv();
  const { id } = c.req.valid("param");

  if (env.CATALOG_BACKUP_BUCKET.length === 0) throw backupsNotConfigured();

  const key = await findBackupKey(id);
  if (!key) throw backupNotFound();

  const snapshot = await loadSnapshot(env.CATALOG_BACKUP_BUCKET, key);
  const plan = planCatalogRestore(snapshot, await loadLiveStateForPlan());

  // A dry run touches nothing → a plain read log, no audit row.
  log.info(
    {
      event: "admin_restore_previewed",
      adminId: admin.id,
      backupId: id,
      willArchive: plan.willArchive.productCount + plan.willArchive.categoryCount,
    },
    "admin_restore_previewed",
  );
  return c.json(plan, 200);
});

// ─── POST /admin/archive/backups/{id}/restore ─────────────────────────────────

const restoreRoute = createRoute({
  method: "post",
  path: "/backups/{id}/restore",
  tags: ["admin-archive"],
  summary: "Replay a snapshot over the live catalog (typed-confirmed, safety-backed)",
  request: {
    params: z.object({ id: z.string().uuid() }),
    body: { content: { "application/json": { schema: RestoreRequestSchema } } },
  },
  responses: {
    201: {
      description: "The restore applied, plus the pre-restore safety backup.",
      content: { "application/json": { schema: RestoreResultSchema } },
    },
    400: {
      description: "`/problems/restore-confirmation-required` — the typed confirmation is missing/wrong.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    404: {
      description: "No admin session, or no backup with that id.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    422: {
      description: "`/problems/snapshot-invalid` — the stored object is not a valid snapshot.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    502: {
      description: "`/problems/snapshot-read-failed` or `/problems/backup-failed` — storage error.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    503: {
      description: "`/problems/backups-not-configured` — no backup bucket set.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminArchiveRoutes.openapi(restoreRoute, async (c) => {
  const db = getDb();
  const admin = c.get("user")!;
  const log = c.get("logger") ?? baseLogger;
  const env = parseEnv();
  const { id } = c.req.valid("param");
  const { confirm } = c.req.valid("json");

  if (confirm !== RESTORE_CONFIRMATION) throw restoreConfirmationRequired();
  if (env.CATALOG_BACKUP_BUCKET.length === 0) throw backupsNotConfigured();

  const key = await findBackupKey(id);
  if (!key) throw backupNotFound();

  const snapshot = await loadSnapshot(env.CATALOG_BACKUP_BUCKET, key);

  // 1) SAFETY BACKUP FIRST — never overwrite the live catalog without a rollback
  //    point (the 2026 "tail-log backup before restore" rule). A failure here
  //    aborts the restore (502) before a single row is written.
  let safety: CatalogBackupResult;
  try {
    safety = await backupRunner({
      kind: "manual",
      triggeredByUserId: admin.id,
      logger: log,
    });
  } catch (err) {
    log.error({ err, adminId: admin.id, backupId: id }, "restore_safety_backup_failed");
    throw backupFailed();
  }
  const [safetyRow] = await db
    .select({
      id: schema.catalogBackups.id,
      createdAt: schema.catalogBackups.createdAt,
    })
    .from(schema.catalogBackups)
    .where(eq(schema.catalogBackups.s3Key, safety.key))
    .orderBy(desc(schema.catalogBackups.createdAt))
    .limit(1);
  if (!safetyRow) throw backupFailed();

  // 2) Plan from the PRE-replay live state — returned as "what was applied".
  const plan = planCatalogRestore(snapshot, await loadLiveStateForPlan());

  // 3) One transactional replay (Neon opens a WebSocket for db.transaction; §13).
  await db.transaction(async (tx) => {
    const now = new Date();

    // Categories: upsert every snapshot row (restoring deleted_at too), parent
    // before child so a rare genuinely-new row satisfies the self-FK on insert.
    for (const cat of orderCategoriesParentFirst(snapshot.categories)) {
      await tx
        .insert(schema.categories)
        .values({
          id: cat.id,
          slug: cat.slug,
          name: cat.name,
          parentId: cat.parentId,
          imageS3Key: cat.imageS3Key,
          displayOrder: cat.displayOrder,
          deletedAt: cat.deletedAt,
          createdAt: cat.createdAt,
          updatedAt: cat.updatedAt,
        })
        .onConflictDoUpdate({
          target: schema.categories.id,
          set: {
            slug: cat.slug,
            name: cat.name,
            parentId: cat.parentId,
            imageS3Key: cat.imageS3Key,
            displayOrder: cat.displayOrder,
            deletedAt: cat.deletedAt,
            createdAt: cat.createdAt,
            updatedAt: cat.updatedAt,
          },
        });
    }

    // Products: upsert every snapshot row (categories exist now → FK-safe).
    for (const p of snapshot.products) {
      await tx
        .insert(schema.products)
        .values({
          id: p.id,
          slug: p.slug,
          code: p.code,
          name: p.name,
          description: p.description,
          priceCents: p.priceCents,
          currency: p.currency,
          categoryId: p.categoryId,
          stockStatus: p.stockStatus,
          newUntil: p.newUntil,
          displayOrder: p.displayOrder,
          deletedAt: p.deletedAt,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        })
        .onConflictDoUpdate({
          target: schema.products.id,
          set: {
            slug: p.slug,
            code: p.code,
            name: p.name,
            description: p.description,
            priceCents: p.priceCents,
            currency: p.currency,
            categoryId: p.categoryId,
            stockStatus: p.stockStatus,
            newUntil: p.newUntil,
            displayOrder: p.displayOrder,
            deletedAt: p.deletedAt,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
          },
        });
    }

    // product_images: replace the image set of every product IN the snapshot
    // (delete-then-insert, scoped by product id). Newer products keep theirs.
    const snapProductIds = snapshot.products.map((p) => p.id);
    if (snapProductIds.length > 0) {
      await tx
        .delete(schema.productImages)
        .where(inArray(schema.productImages.productId, snapProductIds));
    }
    if (snapshot.productImages.length > 0) {
      await tx.insert(schema.productImages).values(
        snapshot.productImages.map((img) => ({
          id: img.id,
          productId: img.productId,
          s3Key: img.s3Key,
          altText: img.altText,
          displayOrder: img.displayOrder,
          createdAt: img.createdAt,
        })),
      );
    }

    // banner_slides: full replace (presentation-only, no dependents; the safety
    // backup preserves the old set since banners have no soft-delete column).
    await tx.delete(schema.bannerSlides);
    if (snapshot.bannerSlides.length > 0) {
      await tx.insert(schema.bannerSlides).values(
        snapshot.bannerSlides.map((b) => ({
          id: b.id,
          imageS3Key: b.imageS3Key,
          title: b.title,
          subtitle: b.subtitle,
          linkUrl: b.linkUrl,
          isActive: b.isActive,
          displayOrder: b.displayOrder,
          createdAt: b.createdAt,
          updatedAt: b.updatedAt,
        })),
      );
    }

    // Rows created AFTER the snapshot → SOFT-delete (reversible, FK-safe), never
    // hard-delete. An already-archived newer row is left as-is (no-op).
    const snapCatIds = snapshot.categories.map((c) => c.id);
    await tx
      .update(schema.categories)
      .set({ deletedAt: now })
      .where(
        snapCatIds.length > 0
          ? and(
              isNull(schema.categories.deletedAt),
              notInArray(schema.categories.id, snapCatIds),
            )
          : isNull(schema.categories.deletedAt),
      );
    await tx
      .update(schema.products)
      .set({ deletedAt: now })
      .where(
        snapProductIds.length > 0
          ? and(
              isNull(schema.products.deletedAt),
              notInArray(schema.products.id, snapProductIds),
            )
          : isNull(schema.products.deletedAt),
      );

    // A live catalog URL must never 301: clear any redirect whose source path
    // now maps to a LIVE product/category (reuses the per-item restore helpers,
    // applied in bulk over the post-replay live tree). Synthesising NEW redirects
    // for the rows this archives is out of scope (documented) — the safety backup
    // makes the whole operation reversible.
    const liveCats: CatRow[] = await tx
      .select({
        id: schema.categories.id,
        slug: schema.categories.slug,
        name: schema.categories.name,
        parentId: schema.categories.parentId,
      })
      .from(schema.categories)
      .where(isNull(schema.categories.deletedAt));
    const liveProds = await tx
      .select({
        id: schema.products.id,
        slug: schema.products.slug,
        categoryId: schema.products.categoryId,
      })
      .from(schema.products)
      .where(isNull(schema.products.deletedAt));
    const livePaths = new Set<string>();
    for (const cat of liveCats) {
      const chain = ancestorSlugChain(liveCats, cat.id);
      if (chain) livePaths.add(categoryUrlFromChain(chain));
    }
    for (const p of liveProds) {
      const chain = p.categoryId ? ancestorSlugChain(liveCats, p.categoryId) : null;
      livePaths.add(productCanonicalPath(chain, p.slug));
    }
    if (livePaths.size > 0) {
      await tx
        .delete(schema.redirects)
        .where(inArray(schema.redirects.sourcePath, [...livePaths]));
    }

    // Audit (GDPR Art. 30) — the single most consequential admin action.
    await tx.insert(schema.adminAuditLog).values({
      actorUserId: admin.id,
      action: "catalog.restore",
      entityTable: "catalog_backups",
      entityId: id,
      changes: {
        backupKey: key,
        takenAt: snapshot.takenAt,
        safetyBackupKey: safety.key,
        snapshotCounts: plan.counts,
        archivedProducts: plan.willArchive.productCount,
        archivedCategories: plan.willArchive.categoryCount,
      },
      userAgent: c.req.header("user-agent") ?? null,
    });
  });

  // WARN, not info — a full catalog overwrite is worth surfacing in the logs.
  log.warn(
    {
      event: "catalog_restored",
      adminId: admin.id,
      backupId: id,
      backupKey: key,
      safetyBackupKey: safety.key,
      archived: plan.willArchive.productCount + plan.willArchive.categoryCount,
    },
    "catalog_restored",
  );

  return c.json(
    {
      restored: plan,
      safetyBackupId: safetyRow.id,
      safetyBackupCreatedAt: safetyRow.createdAt.toISOString(),
    },
    201,
  );
});
