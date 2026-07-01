import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { schema } from "@shop/db";
import type { Logger } from "pino";
import { getDb } from "../../lib/db.js";
import { ApiError, ProblemSchema, badRequest } from "../../lib/errors.js";
import { logger as baseLogger } from "../../lib/logger.js";
import {
  coerceSettings,
  isSettingKey,
  type SettingKey,
  type SettingsValues,
  validateSetting,
} from "../../lib/settings.js";
import { validationHook } from "../../lib/validation-hook.js";
import { requireAdmin } from "../../middleware/admin.js";
import type { AuthVariables } from "../../middleware/auth.js";

/**
 * Admin store settings — the real /admin/settings screen
 * (docs/README.md §"Настройки на магазина"). The fifth admin CRUD slice; the
 * first writer of the dormant key-value `settings` table beyond the seed, and
 * the slice that moves operator-editable business config (shop phone, address,
 * hours, default pickup window, admin-notification recipient) off environment
 * variables and onto a runtime-editable store — see lib/settings.ts for the
 * config-vs-data rationale and docs/ARCHITECTURE.md §13.
 *
 * Surface (behind `requireAdmin` — non-admins get the uniform 404):
 *
 *   GET    /admin/settings    every setting value + a document version token
 *   PATCH  /admin/settings    update one or more settings (optimistic-locked)
 *
 * Design notes (consistent with the categories/products/banners slices):
 *
 *   - **Document-level optimistic lock.** A key-value document has no single
 *     `updatedAt`, so the version token is the MAX `updated_at` across all
 *     setting rows (ISO). The screen echoes it back as `expectedVersion`; PATCH
 *     re-reads the rows `FOR UPDATE`, recomputes the max, and compares in JS at
 *     millisecond precision before writing → 409 on a stale tab. Same
 *     read-compare-write-under-row-lock shape as the other admin slices, with no
 *     `version` column (no migration).
 *   - **Strict allow-list.** Only the registry keys are accepted; an unknown key
 *     is a clean 400. Each value is validated + normalised by lib/settings.ts
 *     (trim, control-char strip, length cap, phone/email format) before it ever
 *     reaches the DB — the write half of OWASP "validate input, encode output".
 *   - **Audit trail.** Each save appends one `admin_audit_log` row recording the
 *     before/after of exactly the keys that changed (GDPR Art. 30).
 */

type AdminSettingsVariables = AuthVariables & {
  logger: Logger;
  requestId: string;
};

export const adminSettingsRoutes = new OpenAPIHono<{
  Variables: AdminSettingsVariables;
}>({
  defaultHook: validationHook,
});

// currentUser runs in app.ts; requireAdmin flattens the surface to 404 for
// non-admins — same posture as the rest of the admin routes.
adminSettingsRoutes.use("*", requireAdmin);

// ─── DTOs ────────────────────────────────────────────────────────────────────

/**
 * Every setting value, keyed by the registry key (snake_case — these are
 * identifiers the PATCH body speaks back, not display strings). A complete
 * object always: missing rows fall back to defaults (lib/settings.ts).
 */
const SettingsValuesSchema = z
  .object({
    default_pickup_deadline_days: z.number().int(),
    store_address: z.string(),
    store_hours: z.string(),
    store_phone: z.string(),
    store_email: z.string(),
    admin_notification_email: z.string(),
  })
  .openapi("AdminSettingsValues");

const AdminSettingsSchema = z
  .object({
    values: SettingsValuesSchema,
    /** MAX(updated_at) across all rows — the optimistic-lock token. */
    version: z.string(),
  })
  .openapi("AdminSettings");

export type AdminSettings = z.infer<typeof AdminSettingsSchema>;

const UpdateRequestSchema = z
  .object({
    /** The `version` the screen rendered from (optimistic lock). */
    expectedVersion: z.string().min(1),
    /**
     * The keys to change → their new values. Validated per-key in the handler
     * against the registry (unknown key → 400; bad value → field 400). Left as
     * `unknown` here so the precise, localised messages come from
     * lib/settings.ts rather than a generic Zod union error.
     */
    values: z.record(z.string(), z.unknown()),
  })
  .strict()
  .openapi("AdminSettingsUpdateRequest");

// ─── Helpers ───────────────────────────────────────────────────────────────────

function versionConflict(): ApiError {
  return new ApiError({
    type: "/problems/settings-version-conflict",
    title: "Settings Were Updated Concurrently",
    status: 409,
    detail:
      "The settings changed since your screen loaded. Reload and re-apply your changes.",
  });
}

/** ISO of the latest updated_at across rows, or the epoch for an empty table. */
function versionOf(rows: ReadonlyArray<{ updatedAt: Date }>): string {
  let maxMs = 0;
  for (const r of rows) {
    const ms = r.updatedAt.getTime();
    if (ms > maxMs) maxMs = ms;
  }
  return new Date(maxMs).toISOString();
}

function clientMeta(c: {
  req: { header: (n: string) => string | undefined };
}): { userAgent: string | null } {
  return { userAgent: c.req.header("user-agent") ?? null };
}

// ─── GET /admin/settings ───────────────────────────────────────────────────────

const getRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["admin-settings"],
  summary: "All store settings + the optimistic-lock version token",
  responses: {
    200: {
      description: "Every setting value and the document version.",
      content: { "application/json": { schema: AdminSettingsSchema } },
    },
    404: {
      description: "No admin session (uniform with the rest of the surface).",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminSettingsRoutes.openapi(getRoute, async (c) => {
  const db = getDb();
  const rows = await db
    .select({
      key: schema.settings.key,
      value: schema.settings.value,
      updatedAt: schema.settings.updatedAt,
    })
    .from(schema.settings);

  return c.json(
    { values: coerceSettings(rows), version: versionOf(rows) },
    200,
  );
});

// ─── PATCH /admin/settings ─────────────────────────────────────────────────────

const updateRoute = createRoute({
  method: "patch",
  path: "/",
  tags: ["admin-settings"],
  summary: "Update one or more store settings",
  request: {
    body: { content: { "application/json": { schema: UpdateRequestSchema } } },
  },
  responses: {
    200: {
      description: "The refreshed settings + new version.",
      content: { "application/json": { schema: AdminSettingsSchema } },
    },
    400: {
      description: "Validation error (unknown key, bad value, empty patch).",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    404: {
      description: "No admin session.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    409: {
      description: "`/problems/settings-version-conflict` (stale screen).",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminSettingsRoutes.openapi(updateRoute, async (c) => {
  const db = getDb();
  const admin = c.get("user")!;
  const log = c.get("logger") ?? baseLogger;
  const body = c.req.valid("json");

  const expectedMs = Date.parse(body.expectedVersion);
  if (Number.isNaN(expectedMs)) {
    throw badRequest("expectedVersion is not a valid timestamp.", [
      { path: "expectedVersion", message: "Must be an ISO-8601 timestamp." },
    ]);
  }

  // Validate + normalise every supplied key against the registry BEFORE the
  // transaction, so a bad value is a clean 400 that never opens a write txn.
  const entries = Object.entries(body.values);
  if (entries.length === 0) {
    throw badRequest("No settings to update.", [
      { path: "values", message: "Provide at least one setting to change." },
    ]);
  }

  const clean: Partial<Record<SettingKey, SettingsValues[SettingKey]>> = {};
  const fieldErrors: { path: string; message: string }[] = [];
  for (const [key, raw] of entries) {
    if (!isSettingKey(key)) {
      fieldErrors.push({ path: `values.${key}`, message: "Непозната настройка." });
      continue;
    }
    const res = validateSetting(key, raw);
    if (!res.ok) {
      fieldErrors.push({ path: `values.${key}`, message: res.message });
    } else {
      clean[key] = res.value;
    }
  }
  if (fieldErrors.length > 0) {
    throw badRequest("Settings validation failed.", fieldErrors);
  }

  const changedKeys = Object.keys(clean) as SettingKey[];

  const result = await db.transaction(async (tx) => {
    const locked = await tx
      .select({
        key: schema.settings.key,
        value: schema.settings.value,
        updatedAt: schema.settings.updatedAt,
      })
      .from(schema.settings)
      .for("update");

    if (versionOf(locked) !== new Date(expectedMs).toISOString()) {
      return { kind: "conflict" as const };
    }

    const before = coerceSettings(locked);
    const now = new Date();
    for (const key of changedKeys) {
      await tx
        .insert(schema.settings)
        .values({
          key,
          value: clean[key] as unknown,
          updatedByUserId: admin.id,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: schema.settings.key,
          set: { value: clean[key] as unknown, updatedByUserId: admin.id, updatedAt: now },
        });
    }

    const refreshed = await tx
      .select({
        key: schema.settings.key,
        value: schema.settings.value,
        updatedAt: schema.settings.updatedAt,
      })
      .from(schema.settings);

    const after = coerceSettings(refreshed);
    const beforeChanged: Record<string, unknown> = {};
    const afterChanged: Record<string, unknown> = {};
    for (const key of changedKeys) {
      beforeChanged[key] = before[key];
      afterChanged[key] = after[key];
    }

    await tx.insert(schema.adminAuditLog).values({
      actorUserId: admin.id,
      action: "settings.update",
      entityTable: "settings",
      entityId: changedKeys.join(","),
      changes: { before: beforeChanged, after: afterChanged },
      userAgent: clientMeta(c).userAgent,
    });

    return {
      kind: "ok" as const,
      values: after,
      version: versionOf(refreshed),
    };
  });

  if (result.kind === "conflict") throw versionConflict();

  log.info(
    { adminId: admin.id, changedKeys, count: changedKeys.length },
    "settings_updated",
  );
  return c.json({ values: result.values, version: result.version }, 200);
});
