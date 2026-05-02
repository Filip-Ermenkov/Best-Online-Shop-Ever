import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { schema } from "@shop/db";
import { asc, isNull, sql } from "drizzle-orm";
import { getDb } from "../lib/db.js";
import { ProblemSchema } from "../lib/errors.js";
import { buildImageUrl } from "../lib/images.js";
import { validationHook } from "../lib/validation-hook.js";

// ─── Public DTOs (OpenAPI-aware) ───────────────────────────────────────────

/**
 * One node in the tree. `imageUrl` is derived from the stored S3 key — never
 * exposed as a raw key (see images.ts). `children` is recursive — Zod requires
 * an explicit type annotation on the wrapping schema for `z.lazy()` to type-
 * check, and `@hono/zod-openapi` needs the schema to be `.openapi()`-named
 * for the recursion to generate a `$ref` rather than an inlined cycle.
 */
export type CategoryNode = {
  id: string;
  slug: string;
  name: string;
  imageUrl: string | null;
  displayOrder: number;
  children: CategoryNode[];
};

const CategoryNodeSchema: z.ZodType<CategoryNode> = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    name: z.string(),
    imageUrl: z.string().url().nullable(),
    displayOrder: z.number().int(),
    get children() {
      return z.array(CategoryNodeSchema);
    },
  })
  .openapi("CategoryNode");

const CategoryTreeSchema = z
  .object({
    items: z.array(CategoryNodeSchema),
  })
  .openapi("CategoryTree");

// ─── Helpers ───────────────────────────────────────────────────────────────

const SHARED_CACHE_HEADERS = {
  // Categories change rarely — admins reorganise the tree maybe a few times a
  // year. CloudFront holds for 5 minutes, serves stale up to a minute on miss.
  // Browsers always revalidate; the ETag handshake makes that cheap (304).
  "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=60",
  Vary: "Accept-Encoding",
};

/**
 * Assemble the parent→children tree from a flat list. Single pass:
 *   1. Build a map id→node.
 *   2. Walk the list a second time, attaching each node to either its parent's
 *      children array, or to the roots collection if parent_id is null.
 *
 * Sort order in the input list is the SQL `ORDER BY parent_id NULLS FIRST,
 * display_order, name` — that keeps the children of every parent in the right
 * order without a second sort pass.
 */
function buildTree(
  rows: Array<{
    id: string;
    slug: string;
    name: string;
    imageS3Key: string | null;
    parentId: string | null;
    displayOrder: number;
  }>,
): CategoryNode[] {
  const byId = new Map<string, CategoryNode>();
  const roots: CategoryNode[] = [];

  for (const r of rows) {
    byId.set(r.id, {
      id: r.id,
      slug: r.slug,
      name: r.name,
      imageUrl: r.imageS3Key ? buildImageUrl(r.imageS3Key) : null,
      displayOrder: r.displayOrder,
      children: [],
    });
  }

  for (const r of rows) {
    const node = byId.get(r.id)!;
    if (r.parentId === null) {
      roots.push(node);
    } else {
      const parent = byId.get(r.parentId);
      // Defensive: a parent could be soft-deleted while a child isn't.
      // We exclude deleted nodes in the SQL WHERE, so an orphan child is a
      // data integrity bug, not an expected branch. Promote to a root rather
      // than silently dropping — admins can fix the link in the panel.
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }
  }

  return roots;
}

// ─── Route definitions ─────────────────────────────────────────────────────

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["categories"],
  summary: "Get the full category tree",
  description:
    "Returns every non-deleted category as a single nested tree. This is " +
    "the source of truth for the storefront navigation menu and the homepage " +
    "categories grid. Cached for 5 minutes at the edge — admin edits go " +
    "live within that window (a future revalidation hook will purge sooner).",
  responses: {
    200: {
      description: "The full tree of live categories.",
      content: { "application/json": { schema: CategoryTreeSchema } },
    },
    400: {
      description: "Invalid query parameters.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

// ─── Router ────────────────────────────────────────────────────────────────

export const categoriesRoutes = new OpenAPIHono({
  defaultHook: validationHook,
});

categoriesRoutes.openapi(listRoute, async (c) => {
  const db = getDb();

  // One query, all live rows. At this catalog size (a few dozen rows) a flat
  // SELECT plus an in-memory tree build is faster and simpler than a recursive
  // CTE that returns JSON. If the catalog ever grows past a few hundred
  // categories, switch to a recursive CTE that prunes by depth or branch.
  const rows = await db
    .select({
      id: schema.categories.id,
      slug: schema.categories.slug,
      name: schema.categories.name,
      imageS3Key: schema.categories.imageS3Key,
      parentId: schema.categories.parentId,
      displayOrder: schema.categories.displayOrder,
    })
    .from(schema.categories)
    .where(isNull(schema.categories.deletedAt))
    // parentId NULLS FIRST so roots are processed before their children. Not
    // strictly required (we do two passes anyway) but keeps mental model
    // simple if the build logic ever changes.
    .orderBy(
      sql`${schema.categories.parentId} ASC NULLS FIRST`,
      asc(schema.categories.displayOrder),
      asc(schema.categories.name),
    );

  const items = buildTree(rows);
  return c.json({ items }, 200, SHARED_CACHE_HEADERS);
});
