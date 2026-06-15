/**
 * Pure category-tree helpers — no DB, no I/O, no Hono. The admin
 * category-management route (routes/admin/categories.ts) is the only caller,
 * but keeping these functions pure means they unit-test in isolation (the
 * cycle check, the descendant collection, and the URL builders are the parts
 * with the most edge cases) and the same logic can serve a future admin-api
 * Lambda without dragging route wiring along — exactly the split @shop/auth
 * uses for crypto and lib/order-status.ts uses for the order state machine.
 *
 * The catalog is small (a few dozen categories), so every traversal here is an
 * in-memory walk over a flat row list rather than a recursive SQL CTE — the
 * same call the public GET /categories route makes (see routes/categories.ts).
 * If the catalog ever grows past a few hundred categories, the descendant
 * collection moves to a recursive CTE; nothing else here changes.
 */

/**
 * Order statuses that count as "active" for the deletion-impact warning the
 * spec mandates (docs/README.md §"Управление на категории"): deleting a
 * category whose products sit in one of these warns the admin that catalog
 * rows will disappear while the orders keep their snapshots. `accepted` /
 * `returned` / `cancelled` are terminal and excluded — the spec lists exactly
 * these four.
 */
export const ACTIVE_ORDER_STATUSES_FOR_DELETION = [
  "processing",
  "shipped",
  "ready_for_pickup",
  "delivered",
] as const;

/**
 * Slug contract: lowercase latin letters, digits, and single hyphens between
 * runs — never leading/trailing/double hyphens. Matches the storefront URL
 * grammar (/products/<slug>/...) and the spec's "само латиница, цифри, тирета".
 */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

/**
 * Bulgarian → Latin transliteration, byte-for-byte identical to the frontend's
 * `slugify` (frontend/src/lib/utils.ts) so a slug the admin form auto-derives
 * on the client and a slug the API derives from an omitted field are the same
 * string. Official BDS / passport-style mix.
 */
const BG_TO_LATIN: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ж: "zh", з: "z",
  и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p",
  р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch",
  ш: "sh", щ: "sht", ъ: "a", ь: "y", ю: "yu", я: "ya",
  А: "A", Б: "B", В: "V", Г: "G", Д: "D", Е: "E", Ж: "Zh", З: "Z",
  И: "I", Й: "Y", К: "K", Л: "L", М: "M", Н: "N", О: "O", П: "P",
  Р: "R", С: "S", Т: "T", У: "U", Ф: "F", Х: "H", Ц: "Ts", Ч: "Ch",
  Ш: "Sh", Щ: "Sht", Ъ: "A", Ь: "Y", Ю: "Yu", Я: "Ya",
};

/** Convert (possibly Bulgarian) text to a URL-friendly lowercase slug. */
export function slugify(text: string): string {
  return text
    .split("")
    .map((ch) => BG_TO_LATIN[ch] ?? ch)
    .join("")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Minimal flat shape the pure traversals need. */
export interface CatRow {
  id: string;
  slug: string;
  name: string;
  parentId: string | null;
}

/** id → row, for O(1) parent hops. */
function indexById<T extends { id: string }>(rows: T[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const r of rows) m.set(r.id, r);
  return m;
}

/**
 * Every descendant id of `rootId` (children, grandchildren, …) — NOT including
 * `rootId` itself. Order is breadth-first but callers treat it as a set.
 * A malformed parent cycle (must not occur — the move endpoint forbids it) is
 * defended against with a visited guard so this can never infinite-loop.
 */
export function collectDescendantIds(rows: CatRow[], rootId: string): string[] {
  const childrenByParent = new Map<string, string[]>();
  for (const r of rows) {
    if (r.parentId === null) continue;
    const list = childrenByParent.get(r.parentId);
    if (list) list.push(r.id);
    else childrenByParent.set(r.parentId, [r.id]);
  }

  const out: string[] = [];
  const seen = new Set<string>([rootId]);
  const queue = [...(childrenByParent.get(rootId) ?? [])];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    const kids = childrenByParent.get(id);
    if (kids) queue.push(...kids);
  }
  return out;
}

/**
 * The slug chain from the root down to (and including) `id`, e.g.
 * ["elektronika", "telefoni", "smartfoni"]. Returns null if a link is missing
 * (an orphaned row — a data-integrity bug, not an expected branch). Visited
 * guard prevents an infinite walk on a malformed cycle.
 */
export function ancestorSlugChain(rows: CatRow[], id: string): string[] | null {
  const byId = indexById(rows);
  const chain: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = id;
  while (cursor !== null) {
    if (seen.has(cursor)) return null; // cycle — give up rather than loop
    seen.add(cursor);
    const row: CatRow | undefined = byId.get(cursor);
    if (!row) return null; // broken link
    chain.push(row.slug);
    cursor = row.parentId;
  }
  return chain.reverse();
}

/** Storefront URL for a category given its root→node slug chain. */
export function categoryUrlFromChain(chain: string[]): string {
  return `/products/${chain.join("/")}`;
}

/** Storefront URL for a product sitting under a category slug chain. */
export function productUrl(categoryChain: string[], productSlug: string): string {
  return `/products/${[...categoryChain, productSlug].join("/")}`;
}

/**
 * Would re-parenting `nodeId` under `newParentId` create a cycle? True when the
 * target is the node itself or any of its descendants — both would detach a
 * subtree from the root and make `ancestorSlugChain` loop. Moving to root
 * (null) is always safe.
 */
export function wouldCreateCycle(
  rows: CatRow[],
  nodeId: string,
  newParentId: string | null,
): boolean {
  if (newParentId === null) return false;
  if (newParentId === nodeId) return true;
  const byId = indexById(rows);
  const seen = new Set<string>();
  let cursor: string | null = newParentId;
  while (cursor !== null) {
    if (cursor === nodeId) return true; // nodeId is an ancestor of the target
    if (seen.has(cursor)) return false; // pre-existing cycle elsewhere; not ours
    seen.add(cursor);
    cursor = byId.get(cursor)?.parentId ?? null;
  }
  return false;
}
