import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { schema } from "@shop/db";
import { desc, eq, isNotNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Logger } from "pino";
import {
  runCatalogBackupJob,
  type CatalogBackupResult,
} from "../../jobs/catalog-backup.js";
import { getDb } from "../../lib/db.js";
import { parseEnv } from "../../lib/env.js";
import { ApiError, ProblemSchema } from "../../lib/errors.js";
import { logger as baseLogger } from "../../lib/logger.js";
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
 *   GET  /admin/archive          soft-deleted products + categories + backups list
 *   POST /admin/archive/backup   trigger an on-demand ("manual") catalog backup
 *
 * (Per-item restore lives with its entity — `POST /admin/products/:id/restore`
 * and the new `POST /admin/categories/:id/restore` — so the archive UI simply
 * calls those; keeping restore beside the CRUD it reverses is the established
 * pattern and avoids a second writer of the same tables.)
 *
 * Design notes (researched against 2026 practice — see ARCHITECTURE §13):
 *
 *   - **Two recovery mechanisms, honestly separated.** Modern "trash/restore"
 *     guidance is to give admins a view of soft-deleted rows with an explicit
 *     per-item restore, kept distinct from harder destructive operations. This
 *     page shows exactly that (the `deleted_at` rows) PLUS the point-in-time
 *     catalog snapshots the scheduler writes. Restoring an INDIVIDUAL archived
 *     product/category is the safe, reversible 80%; restoring the WHOLE catalog
 *     from a snapshot (overwriting live rows) is a high-blast-radius operation
 *     deferred to its own slice with a preview/confirm flow (roadmap item 52).
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

// ─── Backup runner (injectable — same DI posture as the uploads S3 adapters) ──
//
// The one AWS touchpoint on this route is the manual catalog backup. It is
// swappable so the integration tests exercise the full wiring (requireAdmin, the
// 503, the audit row, the response shape) without AWS creds; the real S3 write is
// proven by the catalog-backup job's own tests.

export type BackupRunnerFn = (opts: {
  kind: "manual";
  triggeredByUserId: string;
  logger?: Logger;
}) => Promise<CatalogBackupResult>;

let backupRunner: BackupRunnerFn = (opts) => runCatalogBackupJob(opts);

/** Test seam: override the backup runner. */
export function _setArchiveAdaptersForTests(a: { backupRunner?: BackupRunnerFn }): void {
  if (a.backupRunner) backupRunner = a.backupRunner;
}
export function _resetArchiveAdaptersForTests(): void {
  backupRunner = (opts) => runCatalogBackupJob(opts);
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
