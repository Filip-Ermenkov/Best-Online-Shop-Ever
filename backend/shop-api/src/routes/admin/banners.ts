import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { schema } from "@shop/db";
import { asc, eq, sql } from "drizzle-orm";
import type { Logger } from "pino";
import {
  BANNER_LINK_MAX,
  BANNER_SUBTITLE_MAX,
  BANNER_TITLE_MAX,
  normalizeBannerLink,
  normalizeOptionalText,
} from "../../lib/banner.js";
import { getDb } from "../../lib/db.js";
import { ApiError, ProblemSchema, badRequest, notFound } from "../../lib/errors.js";
import { buildImageUrl } from "../../lib/images.js";
import { logger as baseLogger } from "../../lib/logger.js";
import { validationHook } from "../../lib/validation-hook.js";
import { requireAdmin } from "../../middleware/admin.js";
import type { AuthVariables } from "../../middleware/auth.js";

/**
 * Admin banner management — the real /admin/banners screen
 * (docs/README.md §"Управление на банер"). The fourth admin CRUD slice, and the
 * first consumer of the image-upload pipeline's `banners` kind end-to-end.
 *
 * Surface (all behind `requireAdmin` — non-admins get the uniform 404):
 *
 *   GET    /admin/banners            every slide (active + hidden) in order
 *   POST   /admin/banners            create (append to the end of the list)
 *   PATCH  /admin/banners/:id        edit / re-image / re-link / toggle active
 *   POST   /admin/banners/reorder    reorder the slides
 *   DELETE /admin/banners/:id        delete a slide
 *
 * Design notes (consistent with the categories/products slices — ARCHITECTURE
 * §13):
 *
 *   - **Activates the dormant `banner_slides` table.** Modelled since the first
 *     migration (0000) and referenced by the upload pipeline's key layout
 *     (`asset-upload.ts`), but no route could write it. This slice is its first
 *     writer — the same "wire a table the schema already had" move as the
 *     address book and cookie-consent receipts.
 *   - **Optimistic locking WITHOUT a `version` column.** Like categories and
 *     products: the mutating endpoints take the `updatedAt` the admin's screen
 *     rendered from as `expectedUpdatedAt`, re-read the row `FOR UPDATE` inside
 *     the transaction, and compare in JS at millisecond precision before
 *     writing. The row lock makes read-compare-write atomic; the JS compare
 *     sidesteps the Postgres-microsecond vs JS-millisecond equality pitfall.
 *   - **Hard delete, not soft.** A banner is pure presentation — it has no order
 *     history to preserve and no URL to 301 (unlike a category/product), and the
 *     `isActive` toggle already covers "hide without deleting" (the spec's
 *     „Активиране / Деактивиране … без изтриване"). So DELETE removes the row;
 *     the audit entry captures the removed slide for the GDPR Art. 30 record.
 *   - **Internal-link-only click-through.** `linkUrl` is validated server-side to
 *     a same-origin path (lib/banner.ts) so a promo can never become an
 *     open-redirect or an href-injection vector. See that module's rationale.
 *   - **Audit trail.** Every state change appends to `admin_audit_log` in the
 *     same transaction as the write.
 */

type AdminBannersVariables = AuthVariables & {
  logger: Logger;
  requestId: string;
};

export const adminBannersRoutes = new OpenAPIHono<{
  Variables: AdminBannersVariables;
}>({
  defaultHook: validationHook,
});

// currentUser runs in app.ts; requireAdmin turns the whole surface into a flat
// 404 for non-admins — same posture as the rest of the admin routes.
adminBannersRoutes.use("*", requireAdmin);

// ─── DTOs ────────────────────────────────────────────────────────────────────

/**
 * One slide as the admin screen needs it: the raw `imageS3Key` (so an edit can
 * preserve/replace it), the derived `imageUrl` (for the thumbnail), every
 * editable field, and `updatedAt` — the optimistic-lock token echoed back on
 * mutations.
 */
const AdminBannerSlideSchema = z
  .object({
    id: z.string().uuid(),
    imageS3Key: z.string(),
    imageUrl: z.string().url(),
    title: z.string().nullable(),
    subtitle: z.string().nullable(),
    linkUrl: z.string().nullable(),
    isActive: z.boolean(),
    displayOrder: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("AdminBannerSlide");

export type AdminBannerSlide = z.infer<typeof AdminBannerSlideSchema>;

const AdminBannerListSchema = z
  .object({ items: z.array(AdminBannerSlideSchema) })
  .openapi("AdminBannerList");

export type AdminBannerList = z.infer<typeof AdminBannerListSchema>;

const imageKeyField = z.string().trim().min(1).max(500);
const titleField = z.string().max(BANNER_TITLE_MAX).nullable();
const subtitleField = z.string().max(BANNER_SUBTITLE_MAX).nullable();
const linkField = z.string().max(BANNER_LINK_MAX).nullable();

const CreateRequestSchema = z
  .object({
    imageS3Key: imageKeyField,
    title: titleField.optional(),
    subtitle: subtitleField.optional(),
    linkUrl: linkField.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .openapi("AdminBannerCreateRequest");

const UpdateRequestSchema = z
  .object({
    /** The `updatedAt` the screen rendered from (optimistic lock). */
    expectedUpdatedAt: z.string().min(1),
    imageS3Key: imageKeyField.optional(),
    title: titleField.optional(),
    subtitle: subtitleField.optional(),
    linkUrl: linkField.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (
      val.imageS3Key === undefined &&
      val.title === undefined &&
      val.subtitle === undefined &&
      val.linkUrl === undefined &&
      val.isActive === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message: "At least one field to update is required.",
      });
    }
  })
  .openapi("AdminBannerUpdateRequest");

const ReorderRequestSchema = z
  .object({
    /** The slide ids in their new order — must be exactly the current set. */
    orderedIds: z.array(z.string().uuid()).min(1),
  })
  .strict()
  .openapi("AdminBannerReorderRequest");

const DeleteRequestSchema = z
  .object({
    expectedUpdatedAt: z.string().min(1),
  })
  .strict()
  .openapi("AdminBannerDeleteRequest");

// ─── Shared helpers ──────────────────────────────────────────────────────────

type BannerRow = typeof schema.bannerSlides.$inferSelect;

function bannerNotFound(id: string): ApiError {
  return notFound(`No banner slide with id ${id}.`, "/problems/banner-not-found");
}

function versionConflict(id: string): ApiError {
  return new ApiError({
    type: "/problems/banner-version-conflict",
    title: "Banner Was Updated Concurrently",
    status: 409,
    detail: `Banner ${id} changed since your screen loaded. Reload and retry.`,
  });
}

function reorderMismatch(detail: string): ApiError {
  return new ApiError({
    type: "/problems/banner-reorder-mismatch",
    title: "Reorder Set Mismatch",
    status: 409,
    detail,
  });
}

function shape(row: BannerRow): AdminBannerSlide {
  return {
    id: row.id,
    imageS3Key: row.imageS3Key,
    imageUrl: buildImageUrl(row.imageS3Key),
    title: row.title,
    subtitle: row.subtitle,
    linkUrl: row.linkUrl,
    isActive: row.isActive,
    displayOrder: row.displayOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function clientMeta(c: {
  req: { header: (n: string) => string | undefined };
}): { userAgent: string | null } {
  return { userAgent: c.req.header("user-agent") ?? null };
}

/** Validate + normalise a link field, throwing a clean field-400 on failure. */
function resolveLink(raw: string | null | undefined): string | null {
  const res = normalizeBannerLink(raw);
  if (!res.ok) {
    throw badRequest(res.message, [{ path: "linkUrl", message: res.message }]);
  }
  return res.value;
}

async function loadAllSlides(db: ReturnType<typeof getDb>): Promise<BannerRow[]> {
  return db
    .select()
    .from(schema.bannerSlides)
    .orderBy(
      asc(schema.bannerSlides.displayOrder),
      asc(schema.bannerSlides.createdAt),
    );
}

// ─── GET /admin/banners ──────────────────────────────────────────────────────

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["admin-banners"],
  summary: "All banner slides (active and hidden) in display order",
  responses: {
    200: {
      description: "Every slide.",
      content: { "application/json": { schema: AdminBannerListSchema } },
    },
    404: {
      description: "No admin session (uniform with the rest of the surface).",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminBannersRoutes.openapi(listRoute, async (c) => {
  const db = getDb();
  const rows = await loadAllSlides(db);
  return c.json({ items: rows.map(shape) }, 200);
});

// ─── POST /admin/banners ─────────────────────────────────────────────────────

const createRouteDef = createRoute({
  method: "post",
  path: "/",
  tags: ["admin-banners"],
  summary: "Create a banner slide (appended to the end)",
  request: {
    body: { content: { "application/json": { schema: CreateRequestSchema } } },
  },
  responses: {
    201: {
      description: "The created slide.",
      content: { "application/json": { schema: AdminBannerSlideSchema } },
    },
    400: {
      description: "Validation error (bad link, missing image, …).",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminBannersRoutes.openapi(createRouteDef, async (c) => {
  const db = getDb();
  const admin = c.get("user")!;
  const log = c.get("logger") ?? baseLogger;
  const body = c.req.valid("json");

  const linkUrl = resolveLink(body.linkUrl);
  const title = normalizeOptionalText(body.title ?? null);
  const subtitle = normalizeOptionalText(body.subtitle ?? null);

  const created = await db.transaction(async (tx) => {
    // Append to the end: max(displayOrder) + 1 (0 for an empty list).
    const aggRows = await tx
      .select({
        maxOrder: sql<number>`coalesce(max(${schema.bannerSlides.displayOrder}), -1)::int`,
      })
      .from(schema.bannerSlides);
    const maxOrder = aggRows[0]?.maxOrder ?? -1;

    const [row] = await tx
      .insert(schema.bannerSlides)
      .values({
        imageS3Key: body.imageS3Key,
        title,
        subtitle,
        linkUrl,
        isActive: body.isActive ?? true,
        displayOrder: maxOrder + 1,
      })
      .returning();

    await tx.insert(schema.adminAuditLog).values({
      actorUserId: admin.id,
      action: "banner.create",
      entityTable: "banner_slides",
      entityId: row!.id,
      changes: { after: { imageS3Key: row!.imageS3Key, isActive: row!.isActive } },
      userAgent: clientMeta(c).userAgent,
    });
    return row!;
  });

  log.info({ bannerId: created.id, adminId: admin.id }, "banner_created");
  return c.json(shape(created), 201);
});

// ─── PATCH /admin/banners/:id ────────────────────────────────────────────────

const ParamId = z.object({
  id: z.string().uuid().openapi({ param: { name: "id", in: "path" } }),
});

const updateRouteDef = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["admin-banners"],
  summary: "Edit, re-image, re-link, or show/hide a banner slide",
  request: {
    params: ParamId,
    body: { content: { "application/json": { schema: UpdateRequestSchema } } },
  },
  responses: {
    200: {
      description: "The updated slide.",
      content: { "application/json": { schema: AdminBannerSlideSchema } },
    },
    400: {
      description: "Validation error.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    404: {
      description: "`/problems/banner-not-found`.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    409: {
      description: "`/problems/banner-version-conflict` (stale screen).",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminBannersRoutes.openapi(updateRouteDef, async (c) => {
  const db = getDb();
  const admin = c.get("user")!;
  const log = c.get("logger") ?? baseLogger;
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  const expectedMs = Date.parse(body.expectedUpdatedAt);
  if (Number.isNaN(expectedMs)) {
    throw badRequest("expectedUpdatedAt is not a valid timestamp.", [
      { path: "expectedUpdatedAt", message: "Must be an ISO-8601 timestamp." },
    ]);
  }

  // Validate the link BEFORE the transaction so a bad link is a clean 400.
  const nextLink =
    body.linkUrl === undefined ? undefined : resolveLink(body.linkUrl);
  const nextTitle =
    body.title === undefined ? undefined : normalizeOptionalText(body.title);
  const nextSubtitle =
    body.subtitle === undefined
      ? undefined
      : normalizeOptionalText(body.subtitle);

  const updated = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(schema.bannerSlides)
      .where(eq(schema.bannerSlides.id, id))
      .limit(1)
      .for("update");
    if (!locked) return { kind: "not_found" as const };
    if (locked.updatedAt.getTime() !== expectedMs) {
      return { kind: "conflict" as const };
    }

    const [row] = await tx
      .update(schema.bannerSlides)
      .set({
        ...(body.imageS3Key !== undefined ? { imageS3Key: body.imageS3Key } : {}),
        ...(nextTitle !== undefined ? { title: nextTitle } : {}),
        ...(nextSubtitle !== undefined ? { subtitle: nextSubtitle } : {}),
        ...(nextLink !== undefined ? { linkUrl: nextLink } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      })
      .where(eq(schema.bannerSlides.id, id))
      .returning();

    await tx.insert(schema.adminAuditLog).values({
      actorUserId: admin.id,
      action: "banner.update",
      entityTable: "banner_slides",
      entityId: id,
      changes: {
        before: { isActive: locked.isActive, imageS3Key: locked.imageS3Key },
        after: { isActive: row!.isActive, imageS3Key: row!.imageS3Key },
      },
      userAgent: clientMeta(c).userAgent,
    });
    return { kind: "ok" as const, row: row! };
  });

  if (updated.kind === "not_found") throw bannerNotFound(id);
  if (updated.kind === "conflict") throw versionConflict(id);

  log.info({ bannerId: id, adminId: admin.id }, "banner_updated");
  return c.json(shape(updated.row), 200);
});

// ─── POST /admin/banners/reorder ─────────────────────────────────────────────

const reorderRouteDef = createRoute({
  method: "post",
  path: "/reorder",
  tags: ["admin-banners"],
  summary: "Reorder the banner slides",
  request: {
    body: { content: { "application/json": { schema: ReorderRequestSchema } } },
  },
  responses: {
    200: {
      description: "The refreshed slide list.",
      content: { "application/json": { schema: AdminBannerListSchema } },
    },
    409: {
      description:
        "`/problems/banner-reorder-mismatch` — the supplied ids are not exactly the current slide set (the list changed since the screen loaded).",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminBannersRoutes.openapi(reorderRouteDef, async (c) => {
  const db = getDb();
  const admin = c.get("user")!;
  const log = c.get("logger") ?? baseLogger;
  const { orderedIds } = c.req.valid("json");

  if (new Set(orderedIds).size !== orderedIds.length) {
    throw reorderMismatch("The ordered ids contain duplicates.");
  }

  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: schema.bannerSlides.id })
      .from(schema.bannerSlides)
      .for("update");

    const currentIds = new Set(rows.map((r) => r.id));
    const sameSize = currentIds.size === orderedIds.length;
    const sameMembers = orderedIds.every((oid) => currentIds.has(oid));
    if (!sameSize || !sameMembers) {
      throw reorderMismatch(
        "The supplied ids are not exactly the current slides. Reload and retry.",
      );
    }

    for (let i = 0; i < orderedIds.length; i++) {
      await tx
        .update(schema.bannerSlides)
        .set({ displayOrder: i })
        .where(eq(schema.bannerSlides.id, orderedIds[i]!));
    }

    await tx.insert(schema.adminAuditLog).values({
      actorUserId: admin.id,
      action: "banner.reorder",
      entityTable: "banner_slides",
      entityId: "(all)",
      changes: { after: { orderedIds } },
      userAgent: clientMeta(c).userAgent,
    });
  });

  log.info({ count: orderedIds.length, adminId: admin.id }, "banner_reordered");
  const rows = await loadAllSlides(db);
  return c.json({ items: rows.map(shape) }, 200);
});

// ─── DELETE /admin/banners/:id ───────────────────────────────────────────────

const deleteRouteDef = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["admin-banners"],
  summary: "Delete a banner slide",
  request: {
    params: ParamId,
    body: { content: { "application/json": { schema: DeleteRequestSchema } } },
  },
  responses: {
    200: {
      description: "Deletion confirmation.",
      content: {
        "application/json": {
          schema: z
            .object({ deleted: z.boolean() })
            .openapi("AdminBannerDeleteResult"),
        },
      },
    },
    404: {
      description: "`/problems/banner-not-found`.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    409: {
      description: "`/problems/banner-version-conflict`.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminBannersRoutes.openapi(deleteRouteDef, async (c) => {
  const db = getDb();
  const admin = c.get("user")!;
  const log = c.get("logger") ?? baseLogger;
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  const expectedMs = Date.parse(body.expectedUpdatedAt);
  if (Number.isNaN(expectedMs)) {
    throw badRequest("expectedUpdatedAt is not a valid timestamp.", [
      { path: "expectedUpdatedAt", message: "Must be an ISO-8601 timestamp." },
    ]);
  }

  const result = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(schema.bannerSlides)
      .where(eq(schema.bannerSlides.id, id))
      .limit(1)
      .for("update");
    if (!locked) return { kind: "not_found" as const };
    if (locked.updatedAt.getTime() !== expectedMs) {
      return { kind: "conflict" as const };
    }

    await tx.delete(schema.bannerSlides).where(eq(schema.bannerSlides.id, id));

    await tx.insert(schema.adminAuditLog).values({
      actorUserId: admin.id,
      action: "banner.delete",
      entityTable: "banner_slides",
      entityId: id,
      changes: {
        before: {
          imageS3Key: locked.imageS3Key,
          title: locked.title,
          isActive: locked.isActive,
        },
      },
      userAgent: clientMeta(c).userAgent,
    });
    return { kind: "ok" as const };
  });

  if (result.kind === "not_found") throw bannerNotFound(id);
  if (result.kind === "conflict") throw versionConflict(id);

  log.info({ bannerId: id, adminId: admin.id }, "banner_deleted");
  return c.json({ deleted: true }, 200);
});
