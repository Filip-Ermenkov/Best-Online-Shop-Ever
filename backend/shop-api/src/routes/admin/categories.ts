import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { schema } from "@shop/db";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { getDb } from "../../lib/db.js";
import {
  ancestorSlugChain,
  categoryUrlFromChain,
  collectDescendantIds,
  isValidSlug,
  productUrl,
  slugify,
  wouldCreateCycle,
  type CatRow,
  ACTIVE_ORDER_STATUSES_FOR_DELETION,
} from "../../lib/category-tree.js";
import { ApiError, ProblemSchema, badRequest, notFound } from "../../lib/errors.js";
import { buildImageUrl } from "../../lib/images.js";
import { logger as baseLogger } from "../../lib/logger.js";
import { validationHook } from "../../lib/validation-hook.js";
import { requireAdmin } from "../../middleware/admin.js";
import type { AuthVariables } from "../../middleware/auth.js";

/**
 * Admin category management — the second admin CRUD slice
 * (docs/ARCHITECTURE.md §15 item 22; docs/README.md §"Управление на категории").
 *
 * Surface (all behind `requireAdmin` — non-admins get the uniform 404):
 *
 *   GET    /admin/categories                      full live tree + per-node counts
 *   POST   /admin/categories                      create (append to end of layer)
 *   PATCH  /admin/categories/:id                  rename / re-image / MOVE
 *   POST   /admin/categories/reorder              reorder one layer of siblings
 *   GET    /admin/categories/:id/deletion-impact  counts for the confirm dialog
 *   DELETE /admin/categories/:id                  cascade soft-delete + redirects
 *   POST   /admin/categories/:id/restore          un-archive (clears the redirect)
 *
 * Design notes (researched against 2026 practice — see ARCHITECTURE §13):
 *
 *   - **Adjacency list, in-memory traversal.** The schema is `parent_id`
 *     adjacency list (the right model for a small, frequently-moved catalog —
 *     closure tables / ltree earn their cost only past hundreds of nodes). We
 *     load the live rows flat and walk them in memory (lib/category-tree.ts),
 *     exactly as GET /categories does.
 *   - **Optimistic locking WITHOUT a `version` column.** Orders carry an
 *     integer `version` (ARCHITECTURE §13); categories do not, and adding one
 *     is a migration we avoid here. Instead the mutating endpoints take the
 *     `updatedAt` the admin's screen rendered from as `expectedUpdatedAt`, and
 *     the handler re-reads the row `FOR UPDATE` inside the transaction and
 *     compares in JS at millisecond precision before writing. The row lock
 *     makes the read-compare-write atomic (no lost update), and comparing the
 *     driver-truncated `Date` in JS sidesteps the Postgres-microsecond vs
 *     JS-millisecond equality pitfall that a `WHERE updated_at = $1` guard
 *     would hit. Equivalent lost-update protection to the orders version lock
 *     for the single-admin model; RFC 7232 `If-Match` was rejected for the
 *     same reason as on orders (the CDN plays ETag games on GETs).
 *   - **Cascade soft-delete + 301 redirects.** Deleting a category removes it
 *     AND its whole subtree AND every product inside (soft delete via
 *     `deleted_at`; order history is untouched — it snapshots line items). For
 *     every removed URL we write a `redirects` row to the nearest surviving
 *     ancestor (the deleted subtree's parent, or home for a deleted root) so
 *     old links 301 instead of turning into soft-404s — the e-commerce SEO
 *     best practice. The `redirects` table was modelled for exactly this since
 *     the first migration; this slice is its first writer.
 *   - **Spec-mandated confirmation.** DELETE requires `confirmConsequences:
 *     true` (the spec's „Разбирам последствията" checkbox). GET
 *     /:id/deletion-impact returns the subtree/product counts AND how many
 *     products sit in active orders so the UI can render the exact warning the
 *     spec dictates before the destructive call.
 *   - **Audit trail.** Every state change appends to `admin_audit_log`
 *     (GDPR Art. 30 records of processing) in the same transaction as the
 *     write — categories is the first route to activate that dormant table.
 */

type AdminCategoriesVariables = AuthVariables & {
  logger: Logger;
  requestId: string;
};

export const adminCategoriesRoutes = new OpenAPIHono<{
  Variables: AdminCategoriesVariables;
}>({
  defaultHook: validationHook,
});

// currentUser is applied in app.ts (it resolves the cookie); requireAdmin
// turns everything below into a flat 404 for non-admins — same posture as the
// rest of the admin surface, so it stays unconfirmable.
adminCategoriesRoutes.use("*", requireAdmin);

// ─── DTOs ────────────────────────────────────────────────────────────────────

/**
 * One node in the admin tree. Richer than the public `CategoryNode`: it carries
 * `parentId` (the UI needs it to render moves), the raw `imageS3Key` (so an
 * edit can preserve/clear it), `displayOrder`, the two impact counts, and
 * `updatedAt` — the optimistic-lock token the client echoes back on mutations.
 */
export type AdminCategoryNode = {
  id: string;
  parentId: string | null;
  slug: string;
  name: string;
  imageS3Key: string | null;
  imageUrl: string | null;
  displayOrder: number;
  /** Live products placed directly in THIS category (not descendants). */
  productCount: number;
  /** Categories anywhere below this one (recursive). */
  descendantCategoryCount: number;
  createdAt: string;
  updatedAt: string;
  children: AdminCategoryNode[];
};

const AdminCategoryNodeSchema: z.ZodType<AdminCategoryNode> = z
  .object({
    id: z.string().uuid(),
    parentId: z.string().uuid().nullable(),
    slug: z.string(),
    name: z.string(),
    imageS3Key: z.string().nullable(),
    imageUrl: z.string().url().nullable(),
    displayOrder: z.number().int(),
    productCount: z.number().int(),
    descendantCategoryCount: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
    get children() {
      return z.array(AdminCategoryNodeSchema);
    },
  })
  .openapi("AdminCategoryNode");

const AdminCategoryTreeSchema = z
  .object({ items: z.array(AdminCategoryNodeSchema) })
  .openapi("AdminCategoryTree");

export type AdminCategoryTree = z.infer<typeof AdminCategoryTreeSchema>;

const DeletionImpactSchema = z
  .object({
    categoryId: z.string().uuid(),
    categoryName: z.string(),
    /** Descendant categories that would be removed alongside this one. */
    subcategoryCount: z.number().int(),
    /** Live products in this category + descendants that would be removed. */
    productCount: z.number().int(),
    /** Of those products, how many appear in at least one active order. */
    productsInActiveOrders: z.number().int(),
    /** Distinct active orders touched by those products. */
    activeOrderCount: z.number().int(),
  })
  .openapi("AdminCategoryDeletionImpact");

export type AdminCategoryDeletionImpact = z.infer<typeof DeletionImpactSchema>;

const slugField = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine(isValidSlug, "Slug must be lowercase latin letters, digits and hyphens");

const imageKeyField = z.string().trim().min(1).max(500);

const CreateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    /** Optional — derived from `name` (Bulgarian→Latin) when omitted. */
    slug: slugField.optional(),
    /** null / omitted = top-level (root) category. */
    parentId: z.string().uuid().nullable().optional(),
    imageS3Key: imageKeyField.nullable().optional(),
  })
  .strict()
  .openapi("AdminCategoryCreateRequest");

const UpdateRequestSchema = z
  .object({
    /** The `updatedAt` the screen rendered from (optimistic lock). */
    expectedUpdatedAt: z.string().min(1),
    name: z.string().trim().min(1).max(200).optional(),
    slug: slugField.optional(),
    /** Present = move. `null` moves to root; a uuid moves under that parent. */
    parentId: z.string().uuid().nullable().optional(),
    /** `null` clears the image. */
    imageS3Key: imageKeyField.nullable().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (
      val.name === undefined &&
      val.slug === undefined &&
      val.parentId === undefined &&
      val.imageS3Key === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message: "At least one field to update is required.",
      });
    }
  })
  .openapi("AdminCategoryUpdateRequest");

const ReorderRequestSchema = z
  .object({
    /** The layer being reordered. null = the root layer. */
    parentId: z.string().uuid().nullable(),
    /** The sibling ids in their new order — must be exactly that layer's set. */
    orderedIds: z.array(z.string().uuid()).min(1),
  })
  .strict()
  .openapi("AdminCategoryReorderRequest");

const DeleteRequestSchema = z
  .object({
    expectedUpdatedAt: z.string().min(1),
    /** The spec's „Разбирам последствията" checkbox — must be explicitly true. */
    confirmConsequences: z.literal(true),
  })
  .strict()
  .openapi("AdminCategoryDeleteRequest");

// ─── Shared helpers ──────────────────────────────────────────────────────────

function categoryNotFound(id: string): ApiError {
  return notFound(`No category with id ${id}.`, "/problems/category-not-found");
}

function versionConflict(id: string): ApiError {
  return new ApiError({
    type: "/problems/category-version-conflict",
    title: "Category Was Updated Concurrently",
    status: 409,
    detail: `Category ${id} changed since your screen loaded. Reload and retry.`,
  });
}

function slugConflict(parentId: string | null, slug: string): ApiError {
  return new ApiError({
    type: "/problems/category-slug-conflict",
    title: "Slug Already In Use",
    status: 409,
    detail:
      parentId === null
        ? `A top-level category with slug "${slug}" already exists.`
        : `A category with slug "${slug}" already exists under that parent.`,
  });
}

type CategoryRow = typeof schema.categories.$inferSelect;

/** All live categories as the flat shape the pure helpers + tree builder need. */
async function loadLiveCategories(
  db: ReturnType<typeof getDb>,
): Promise<CategoryRow[]> {
  return db
    .select()
    .from(schema.categories)
    .where(isNull(schema.categories.deletedAt))
    .orderBy(
      sql`${schema.categories.parentId} ASC NULLS FIRST`,
      asc(schema.categories.displayOrder),
      asc(schema.categories.name),
    );
}

/** categoryId → count of live products placed directly in it. */
async function loadDirectProductCounts(
  db: ReturnType<typeof getDb>,
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      categoryId: schema.products.categoryId,
      n: sql<number>`count(*)::int`,
    })
    .from(schema.products)
    .where(isNull(schema.products.deletedAt))
    .groupBy(schema.products.categoryId);
  const m = new Map<string, number>();
  for (const r of rows) if (r.categoryId) m.set(r.categoryId, r.n);
  return m;
}

function shapeNode(row: CategoryRow, productCount: number): AdminCategoryNode {
  return {
    id: row.id,
    parentId: row.parentId,
    slug: row.slug,
    name: row.name,
    imageS3Key: row.imageS3Key,
    imageUrl: row.imageS3Key ? buildImageUrl(row.imageS3Key) : null,
    displayOrder: row.displayOrder,
    productCount,
    descendantCategoryCount: 0, // filled in during the tree assembly below
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    children: [],
  };
}

/**
 * Assemble the nested admin tree from the flat live rows and the product-count
 * map, then fill each node's `descendantCategoryCount` with one post-order
 * pass. Same single-pass attach as GET /categories' `buildTree`, plus the
 * counts. Rows arrive pre-ordered (parent NULLS FIRST, displayOrder, name).
 */
function buildAdminTree(
  rows: CategoryRow[],
  productCounts: Map<string, number>,
): AdminCategoryNode[] {
  const byId = new Map<string, AdminCategoryNode>();
  for (const r of rows) byId.set(r.id, shapeNode(r, productCounts.get(r.id) ?? 0));

  const roots: AdminCategoryNode[] = [];
  for (const r of rows) {
    const node = byId.get(r.id)!;
    const parent = r.parentId ? byId.get(r.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const countDescendants = (node: AdminCategoryNode): number => {
    let total = node.children.length;
    for (const child of node.children) total += countDescendants(child);
    node.descendantCategoryCount = total;
    return total;
  };
  for (const root of roots) countDescendants(root);

  return roots;
}

async function getAdminTree(
  db: ReturnType<typeof getDb>,
): Promise<AdminCategoryNode[]> {
  const [rows, productCounts] = await Promise.all([
    loadLiveCategories(db),
    loadDirectProductCounts(db),
  ]);
  return buildAdminTree(rows, productCounts);
}

/** True when a LIVE category already occupies (parentId, slug), excluding self. */
async function slugTaken(
  db: ReturnType<typeof getDb>,
  parentId: string | null,
  slug: string,
  excludeId?: string,
): Promise<boolean> {
  const conds = [
    isNull(schema.categories.deletedAt),
    eq(schema.categories.slug, slug),
    parentId === null
      ? isNull(schema.categories.parentId)
      : eq(schema.categories.parentId, parentId),
  ];
  if (excludeId) conds.push(sql`${schema.categories.id} <> ${excludeId}`);
  const [hit] = await db
    .select({ id: schema.categories.id })
    .from(schema.categories)
    .where(and(...conds))
    .limit(1);
  return Boolean(hit);
}

/** Flat-shape projection for the pure helpers. */
function toCatRows(rows: CategoryRow[]): CatRow[] {
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    parentId: r.parentId,
  }));
}

function clientMeta(c: {
  req: { header: (n: string) => string | undefined };
}): { userAgent: string | null } {
  return { userAgent: c.req.header("user-agent") ?? null };
}

// ─── GET /admin/categories ─────────────────────────────────────────────────

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["admin-categories"],
  summary: "Full live category tree with per-node counts",
  responses: {
    200: {
      description: "Every non-deleted category as a nested tree.",
      content: { "application/json": { schema: AdminCategoryTreeSchema } },
    },
    404: {
      description: "No admin session (uniform with the rest of the surface).",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminCategoriesRoutes.openapi(listRoute, async (c) => {
  const db = getDb();
  const items = await getAdminTree(db);
  return c.json({ items }, 200);
});

// ─── POST /admin/categories ──────────────────────────────────────────────────

const createRouteDef = createRoute({
  method: "post",
  path: "/",
  tags: ["admin-categories"],
  summary: "Create a category (appended to the end of its layer)",
  request: {
    body: {
      content: { "application/json": { schema: CreateRequestSchema } },
    },
  },
  responses: {
    201: {
      description: "The created category.",
      content: { "application/json": { schema: AdminCategoryNodeSchema } },
    },
    400: {
      description: "Validation error or parent missing/deleted.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    409: {
      description: "`/problems/category-slug-conflict`.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminCategoriesRoutes.openapi(createRouteDef, async (c) => {
  const db = getDb();
  const admin = c.get("user")!;
  const log = c.get("logger") ?? baseLogger;
  const body = c.req.valid("json");

  const parentId = body.parentId ?? null;
  const slug = body.slug ?? slugify(body.name);
  if (!slug || !isValidSlug(slug)) {
    throw badRequest("Could not derive a valid slug from the name.", [
      { path: "slug", message: "Provide a slug (lowercase latin, digits, hyphens)." },
    ]);
  }

  if (parentId !== null) {
    const [parent] = await db
      .select({ id: schema.categories.id })
      .from(schema.categories)
      .where(
        and(eq(schema.categories.id, parentId), isNull(schema.categories.deletedAt)),
      )
      .limit(1);
    if (!parent) {
      throw badRequest("Parent category does not exist.", [
        { path: "parentId", message: "Unknown or deleted parent category." },
      ]);
    }
  }

  if (await slugTaken(db, parentId, slug)) throw slugConflict(parentId, slug);

  const created = await db.transaction(async (tx) => {
    // Append to the end of the layer: max(displayOrder) + 1 (0 for an empty layer).
    const aggRows = await tx
      .select({
        maxOrder: sql<number>`coalesce(max(${schema.categories.displayOrder}), -1)::int`,
      })
      .from(schema.categories)
      .where(
        and(
          isNull(schema.categories.deletedAt),
          parentId === null
            ? isNull(schema.categories.parentId)
            : eq(schema.categories.parentId, parentId),
        ),
      );
    const maxOrder = aggRows[0]?.maxOrder ?? -1;

    const [row] = await tx
      .insert(schema.categories)
      .values({
        name: body.name,
        slug,
        parentId,
        imageS3Key: body.imageS3Key ?? null,
        displayOrder: maxOrder + 1,
      })
      .returning();

    await tx.insert(schema.adminAuditLog).values({
      actorUserId: admin.id,
      action: "category.create",
      entityTable: "categories",
      entityId: row!.id,
      changes: { after: { name: row!.name, slug: row!.slug, parentId: row!.parentId } },
      userAgent: clientMeta(c).userAgent,
    });
    return row!;
  });

  log.info(
    { categoryId: created.id, slug: created.slug, adminId: admin.id },
    "category_created",
  );
  return c.json(shapeNode(created, 0), 201);
});

// ─── PATCH /admin/categories/:id ─────────────────────────────────────────────

const ParamId = z.object({
  id: z.string().uuid().openapi({ param: { name: "id", in: "path" } }),
});

const updateRouteDef = createRoute({
  method: "patch",
  path: "/{id}",
  tags: ["admin-categories"],
  summary: "Rename, re-image, or move a category",
  request: {
    params: ParamId,
    body: { content: { "application/json": { schema: UpdateRequestSchema } } },
  },
  responses: {
    200: {
      description: "The updated category.",
      content: { "application/json": { schema: AdminCategoryNodeSchema } },
    },
    400: {
      description: "Validation error or parent missing/deleted.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    404: {
      description: "`/problems/category-not-found`.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    409: {
      description:
        "`/problems/category-version-conflict` (stale screen) or `/problems/category-slug-conflict`.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    422: {
      description: "`/problems/category-move-cycle` — moving under own descendant.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminCategoriesRoutes.openapi(updateRouteDef, async (c) => {
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

  // Live snapshot for the cycle check + slug/parent validation (read outside the
  // txn; the FOR UPDATE re-read below is the authoritative lock).
  const liveRows = await loadLiveCategories(db);
  const current = liveRows.find((r) => r.id === id);
  if (!current) throw categoryNotFound(id);

  const nextParentId =
    body.parentId === undefined ? current.parentId : body.parentId;
  const nextSlug = body.slug ?? current.slug;

  if (body.parentId !== undefined && body.parentId !== current.parentId) {
    if (body.parentId !== null) {
      const parentRow = liveRows.find((r) => r.id === body.parentId);
      if (!parentRow) {
        throw badRequest("Parent category does not exist.", [
          { path: "parentId", message: "Unknown or deleted parent category." },
        ]);
      }
    }
    if (wouldCreateCycle(toCatRows(liveRows), id, body.parentId)) {
      throw new ApiError({
        type: "/problems/category-move-cycle",
        title: "Invalid Move",
        status: 422,
        detail: "A category cannot be moved under itself or one of its descendants.",
      });
    }
  }

  if (
    (body.slug !== undefined || body.parentId !== undefined) &&
    (await slugTaken(db, nextParentId, nextSlug, id))
  ) {
    throw slugConflict(nextParentId, nextSlug);
  }

  const updated = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(schema.categories)
      .where(and(eq(schema.categories.id, id), isNull(schema.categories.deletedAt)))
      .limit(1)
      .for("update");
    if (!locked) return { kind: "not_found" as const };
    if (locked.updatedAt.getTime() !== expectedMs) {
      return { kind: "conflict" as const };
    }

    const [row] = await tx
      .update(schema.categories)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.slug !== undefined ? { slug: body.slug } : {}),
        ...(body.parentId !== undefined ? { parentId: body.parentId } : {}),
        ...(body.imageS3Key !== undefined ? { imageS3Key: body.imageS3Key } : {}),
      })
      .where(eq(schema.categories.id, id))
      .returning();

    await tx.insert(schema.adminAuditLog).values({
      actorUserId: admin.id,
      action: "category.update",
      entityTable: "categories",
      entityId: id,
      changes: {
        before: {
          name: locked.name,
          slug: locked.slug,
          parentId: locked.parentId,
          imageS3Key: locked.imageS3Key,
        },
        after: {
          name: row!.name,
          slug: row!.slug,
          parentId: row!.parentId,
          imageS3Key: row!.imageS3Key,
        },
      },
      userAgent: clientMeta(c).userAgent,
    });
    return { kind: "ok" as const, row: row! };
  });

  if (updated.kind === "not_found") throw categoryNotFound(id);
  if (updated.kind === "conflict") throw versionConflict(id);

  log.info({ categoryId: id, adminId: admin.id }, "category_updated");
  const productCounts = await loadDirectProductCounts(db);
  const node = shapeNode(updated.row, productCounts.get(id) ?? 0);
  node.descendantCategoryCount = collectDescendantIds(
    toCatRows(await loadLiveCategories(db)),
    id,
  ).length;
  return c.json(node, 200);
});

// ─── POST /admin/categories/reorder ──────────────────────────────────────────

const reorderRouteDef = createRoute({
  method: "post",
  path: "/reorder",
  tags: ["admin-categories"],
  summary: "Reorder the sibling categories within one layer",
  request: {
    body: { content: { "application/json": { schema: ReorderRequestSchema } } },
  },
  responses: {
    200: {
      description: "The refreshed full tree.",
      content: { "application/json": { schema: AdminCategoryTreeSchema } },
    },
    409: {
      description:
        "`/problems/category-reorder-mismatch` — the supplied ids are not exactly the layer's current siblings (the tree changed since the screen loaded).",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminCategoriesRoutes.openapi(reorderRouteDef, async (c) => {
  const db = getDb();
  const admin = c.get("user")!;
  const log = c.get("logger") ?? baseLogger;
  const body = c.req.valid("json");
  const { parentId, orderedIds } = body;

  // Duplicate ids in the payload are a client bug.
  if (new Set(orderedIds).size !== orderedIds.length) {
    throw new ApiError({
      type: "/problems/category-reorder-mismatch",
      title: "Reorder Set Mismatch",
      status: 409,
      detail: "The ordered ids contain duplicates.",
    });
  }

  await db.transaction(async (tx) => {
    const siblings = await tx
      .select({ id: schema.categories.id })
      .from(schema.categories)
      .where(
        and(
          isNull(schema.categories.deletedAt),
          parentId === null
            ? isNull(schema.categories.parentId)
            : eq(schema.categories.parentId, parentId),
        ),
      )
      .for("update");

    const currentIds = new Set(siblings.map((s) => s.id));
    const sameSize = currentIds.size === orderedIds.length;
    const sameMembers = orderedIds.every((oid) => currentIds.has(oid));
    if (!sameSize || !sameMembers) {
      throw new ApiError({
        type: "/problems/category-reorder-mismatch",
        title: "Reorder Set Mismatch",
        status: 409,
        detail:
          "The supplied ids are not exactly the current siblings of that layer. Reload and retry.",
      });
    }

    for (let i = 0; i < orderedIds.length; i++) {
      await tx
        .update(schema.categories)
        .set({ displayOrder: i })
        .where(eq(schema.categories.id, orderedIds[i]!));
    }

    await tx.insert(schema.adminAuditLog).values({
      actorUserId: admin.id,
      action: "category.reorder",
      entityTable: "categories",
      entityId: parentId ?? "(root)",
      changes: { after: { parentId, orderedIds } },
      userAgent: clientMeta(c).userAgent,
    });
  });

  log.info(
    { parentId, count: orderedIds.length, adminId: admin.id },
    "category_reordered",
  );
  const items = await getAdminTree(db);
  return c.json({ items }, 200);
});

// ─── GET /admin/categories/:id/deletion-impact ───────────────────────────────

const impactRouteDef = createRoute({
  method: "get",
  path: "/{id}/deletion-impact",
  tags: ["admin-categories"],
  summary: "Counts for the delete-confirmation dialog",
  request: { params: ParamId },
  responses: {
    200: {
      description: "What a delete would remove + active-order exposure.",
      content: { "application/json": { schema: DeletionImpactSchema } },
    },
    404: {
      description: "`/problems/category-not-found`.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminCategoriesRoutes.openapi(impactRouteDef, async (c) => {
  const db = getDb();
  const { id } = c.req.valid("param");

  const rows = await loadLiveCategories(db);
  const target = rows.find((r) => r.id === id);
  if (!target) throw categoryNotFound(id);

  const descendantIds = collectDescendantIds(toCatRows(rows), id);
  const affectedCategoryIds = [id, ...descendantIds];

  const products = await db
    .select({ id: schema.products.id })
    .from(schema.products)
    .where(
      and(
        isNull(schema.products.deletedAt),
        inArray(schema.products.categoryId, affectedCategoryIds),
      ),
    );
  const productIds = products.map((p) => p.id);

  let productsInActiveOrders = 0;
  let activeOrderCount = 0;
  if (productIds.length > 0) {
    const hits = await db
      .selectDistinct({
        productId: schema.orderItems.productId,
        orderId: schema.orders.id,
      })
      .from(schema.orderItems)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.orderItems.orderId))
      .where(
        and(
          inArray(schema.orderItems.productId, productIds),
          inArray(schema.orders.status, [...ACTIVE_ORDER_STATUSES_FOR_DELETION]),
        ),
      );
    const products = new Set<string>();
    const orders = new Set<string>();
    for (const h of hits) {
      if (h.productId) products.add(h.productId);
      orders.add(h.orderId);
    }
    productsInActiveOrders = products.size;
    activeOrderCount = orders.size;
  }

  return c.json(
    {
      categoryId: id,
      categoryName: target.name,
      subcategoryCount: descendantIds.length,
      productCount: productIds.length,
      productsInActiveOrders,
      activeOrderCount,
    },
    200,
  );
});

// ─── DELETE /admin/categories/:id ────────────────────────────────────────────

const deleteRouteDef = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["admin-categories"],
  summary: "Cascade soft-delete a category, its subtree, and its products",
  request: {
    params: ParamId,
    body: { content: { "application/json": { schema: DeleteRequestSchema } } },
  },
  responses: {
    200: {
      description: "Removal summary.",
      content: {
        "application/json": {
          schema: z
            .object({
              deletedCategories: z.number().int(),
              deletedProducts: z.number().int(),
              redirectsWritten: z.number().int(),
            })
            .openapi("AdminCategoryDeleteResult"),
        },
      },
    },
    404: {
      description: "`/problems/category-not-found`.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    409: {
      description: "`/problems/category-version-conflict`.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminCategoriesRoutes.openapi(deleteRouteDef, async (c) => {
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
      .from(schema.categories)
      .where(and(eq(schema.categories.id, id), isNull(schema.categories.deletedAt)))
      .limit(1)
      .for("update");
    if (!locked) return { kind: "not_found" as const };
    if (locked.updatedAt.getTime() !== expectedMs) {
      return { kind: "conflict" as const };
    }

    const liveRows = await tx
      .select()
      .from(schema.categories)
      .where(isNull(schema.categories.deletedAt));
    const catRows = toCatRows(liveRows);

    const descendantIds = collectDescendantIds(catRows, id);
    const deletedCatIds = [id, ...descendantIds];

    const products = await tx
      .select({ id: schema.products.id, slug: schema.products.slug, categoryId: schema.products.categoryId })
      .from(schema.products)
      .where(
        and(
          isNull(schema.products.deletedAt),
          inArray(schema.products.categoryId, deletedCatIds),
        ),
      );
    const productIds = products.map((p) => p.id);

    // The whole subtree below `locked` disappears, so the nearest SURVIVING
    // ancestor of every removed node is `locked.parentId` (or home for a root).
    const survivingParentId = locked.parentId;
    const redirectTarget =
      survivingParentId === null
        ? { targetKind: "home" as const, targetCategoryId: null }
        : { targetKind: "category" as const, targetCategoryId: survivingParentId };

    const redirectRows: (typeof schema.redirects.$inferInsert)[] = [];
    for (const catId of deletedCatIds) {
      const chain = ancestorSlugChain(catRows, catId);
      if (!chain) continue;
      redirectRows.push({
        sourcePath: categoryUrlFromChain(chain),
        targetKind: redirectTarget.targetKind,
        targetCategoryId: redirectTarget.targetCategoryId,
        statusCode: 301,
      });
    }
    for (const p of products) {
      if (!p.categoryId) continue;
      const chain = ancestorSlugChain(catRows, p.categoryId);
      if (!chain) continue;
      redirectRows.push({
        sourcePath: productUrl(chain, p.slug),
        targetKind: redirectTarget.targetKind,
        targetCategoryId: redirectTarget.targetCategoryId,
        statusCode: 301,
      });
    }

    // Refresh any pre-existing redirect for these exact paths (idempotent on
    // re-delete after a restore): delete-then-insert keeps it simple, no
    // ON CONFLICT excluded gymnastics. sourcePath is UNIQUE.
    let redirectsWritten = 0;
    if (redirectRows.length > 0) {
      const paths = redirectRows.map((r) => r.sourcePath);
      await tx.delete(schema.redirects).where(inArray(schema.redirects.sourcePath, paths));
      await tx.insert(schema.redirects).values(redirectRows);
      redirectsWritten = redirectRows.length;
    }

    const now = new Date();
    await tx
      .update(schema.categories)
      .set({ deletedAt: now })
      .where(inArray(schema.categories.id, deletedCatIds));
    if (productIds.length > 0) {
      await tx
        .update(schema.products)
        .set({ deletedAt: now })
        .where(inArray(schema.products.id, productIds));
    }

    await tx.insert(schema.adminAuditLog).values({
      actorUserId: admin.id,
      action: "category.delete",
      entityTable: "categories",
      entityId: id,
      changes: {
        deletedCategories: deletedCatIds.length,
        deletedProducts: productIds.length,
        redirectsWritten,
        redirectTarget: redirectTarget.targetKind,
      },
      userAgent: clientMeta(c).userAgent,
    });

    return {
      kind: "ok" as const,
      deletedCategories: deletedCatIds.length,
      deletedProducts: productIds.length,
      redirectsWritten,
    };
  });

  if (result.kind === "not_found") throw categoryNotFound(id);
  if (result.kind === "conflict") throw versionConflict(id);

  log.info(
    {
      categoryId: id,
      adminId: admin.id,
      deletedCategories: result.deletedCategories,
      deletedProducts: result.deletedProducts,
      redirectsWritten: result.redirectsWritten,
    },
    "category_deleted",
  );
  return c.json(
    {
      deletedCategories: result.deletedCategories,
      deletedProducts: result.deletedProducts,
      redirectsWritten: result.redirectsWritten,
    },
    200,
  );
});

// ─── POST /admin/categories/:id/restore ──────────────────────────────────────
//
// The counterpart to the cascade delete (docs/README.md §12 — the admin Archive
// page's per-item recovery). Category slug uniqueness is scoped to LIVE rows, so
// a deleted category can NEVER be restored by "recreate" (its slug may have been
// reused) — restore is the only correct un-archive path, and until now it did not
// exist (products had `POST /:id/restore`; categories did not). Mirrors the
// product-restore contract exactly: a single-target un-archive (NOT a cascade —
// descendants and products that were soft-deleted alongside it are restored
// individually), re-homing an orphan whose parent is still deleted to root, and
// clearing the 301 the delete wrote so the URL serves the category again.

function restoreConflict(slug: string, parentId: string | null): ApiError {
  return new ApiError({
    type: "/problems/category-restore-conflict",
    title: "Slug Occupied by a Live Category",
    status: 409,
    detail:
      parentId === null
        ? `A live top-level category now uses slug "${slug}". Rename it (or the archived category) before restoring.`
        : `A live category under that parent now uses slug "${slug}". Rename it before restoring.`,
  });
}

const RestoredCategorySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
    parentId: z.string().uuid().nullable(),
    /** True when the original parent was gone, so it was re-homed to the root. */
    rehomed: z.boolean(),
  })
  .openapi("AdminCategoryRestoreResult");

const restoreRouteDef = createRoute({
  method: "post",
  path: "/{id}/restore",
  tags: ["admin-categories"],
  summary: "Un-archive a soft-deleted category (clears its redirect, re-homes an orphan)",
  request: { params: ParamId },
  responses: {
    200: {
      description: "The restored category and its resolved position.",
      content: { "application/json": { schema: RestoredCategorySchema } },
    },
    404: {
      description: "`/problems/category-not-found` (no archived category with that id).",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    409: {
      description: "`/problems/category-restore-conflict` — a live sibling now holds that slug.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

adminCategoriesRoutes.openapi(restoreRouteDef, async (c) => {
  const db = getDb();
  const admin = c.get("user")!;
  const log = c.get("logger") ?? baseLogger;
  const { id } = c.req.valid("param");

  const outcome = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(schema.categories)
      .where(eq(schema.categories.id, id))
      .limit(1)
      .for("update");
    if (!locked || locked.deletedAt === null) return { kind: "not_found" as const };

    // Live categories (read after the lock) drive the parent-liveness check, the
    // slug-collision guard, and the redirect-path reconstruction.
    const liveRows: CatRow[] = await tx
      .select({
        id: schema.categories.id,
        slug: schema.categories.slug,
        name: schema.categories.name,
        parentId: schema.categories.parentId,
      })
      .from(schema.categories)
      .where(isNull(schema.categories.deletedAt));

    // Re-home to root when the original parent is no longer live (deleted in the
    // same cascade, or since) — never resurrect a live category under a dead one.
    const parentLive =
      locked.parentId === null || liveRows.some((r) => r.id === locked.parentId);
    const restoredParentId = parentLive ? locked.parentId : null;

    // A deleted category's slug is reusable, so a new live sibling may already
    // occupy (parent, slug). Restoring would create a duplicate live node with an
    // ambiguous URL — refuse with a clean 409 rather than corrupt the tree.
    const collision = liveRows.some(
      (r) => r.id !== id && r.parentId === restoredParentId && r.slug === locked.slug,
    );
    if (collision) {
      return { kind: "conflict" as const, slug: locked.slug, parentId: restoredParentId };
    }

    // Clear the 301 written at delete time so the URL serves the category again.
    // Rebuild the canonical path from the RESTORED position (live parent chain +
    // this slug): for the common case — restoring the delete-root whose parent is
    // still live — this reproduces exactly the path the delete redirected. A
    // re-homed orphan clears its new root path (a harmless no-op if none exists).
    const parentChain =
      restoredParentId === null
        ? []
        : (ancestorSlugChain(liveRows, restoredParentId) ?? []);
    const sourcePath = categoryUrlFromChain([...parentChain, locked.slug]);
    await tx.delete(schema.redirects).where(eq(schema.redirects.sourcePath, sourcePath));

    await tx
      .update(schema.categories)
      .set({ deletedAt: null, parentId: restoredParentId })
      .where(eq(schema.categories.id, id));

    await tx.insert(schema.adminAuditLog).values({
      actorUserId: admin.id,
      action: "category.restore",
      entityTable: "categories",
      entityId: id,
      changes: {
        after: { slug: locked.slug, parentId: restoredParentId },
        rehomed: !parentLive,
      },
      userAgent: clientMeta(c).userAgent,
    });

    return {
      kind: "ok" as const,
      name: locked.name,
      slug: locked.slug,
      parentId: restoredParentId,
      rehomed: !parentLive,
    };
  });

  if (outcome.kind === "not_found") throw categoryNotFound(id);
  if (outcome.kind === "conflict") throw restoreConflict(outcome.slug, outcome.parentId);

  log.info(
    { categoryId: id, adminId: admin.id, rehomed: outcome.rehomed },
    "category_restored",
  );
  return c.json(
    {
      id,
      name: outcome.name,
      slug: outcome.slug,
      parentId: outcome.parentId,
      rehomed: outcome.rehomed,
    },
    200,
  );
});
