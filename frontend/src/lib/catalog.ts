/**
 * Catalog helpers — pure functions over the live category tree returned by
 * `fetchCategoryTree()` in `lib/api.ts`.
 *
 * The old `lib/mock-data/categories.ts` exported the same shapes (parentId,
 * isArchived, order) plus client-side ancestry walking. The live API tree uses
 * a different DTO (`CategoryNode` from `@shop/api`) that:
 *   - already nests `children`, so we don't need a flat-list-with-parentId
 *     traversal,
 *   - never includes deleted nodes (server filters `deleted_at IS NULL`), so
 *     there's no `isArchived` to filter on the client,
 *   - uses `displayOrder` instead of `order`.
 *
 * Storefront pages and components that previously imported from `mock-data/*`
 * should import from here instead — passing the tree they obtained from
 * `fetchCategoryTree()` as the first argument. Keeping these functions pure
 * (no module-level state, no fetches) makes them safe in both Server and
 * Client Components and easy to test in isolation.
 *
 * Why a separate module rather than colocating with `lib/api.ts`:
 *   - `lib/api.ts` does HTTP — anything that imports it pulls the Hono RPC
 *     client into the bundle. These pure helpers should be cheap to import
 *     from a Client Component (NavBar, Header autocomplete) without dragging
 *     fetch logic along.
 *
 * The tree-node type comes directly from `@shop/api`'s explicit `CategoryNode`
 * export rather than `InferResponseType<typeof api.categories.$get>` — see
 * `backend/shop-api/src/types.ts` for why (avoids the AppType deep ReturnType
 * chain that degrades to `any` on workspace-symlink hiccups).
 */

import type { CategoryNode } from "@shop/api";

export type CategoryTreeNode = CategoryNode;

/** Walk every node in the tree depth-first, root → leaves. */
export function flattenCategories(
  tree: readonly CategoryTreeNode[],
): CategoryTreeNode[] {
  const out: CategoryTreeNode[] = [];
  for (const node of tree) {
    out.push(node);
    if (node.children.length > 0) {
      out.push(...flattenCategories(node.children));
    }
  }
  return out;
}

/** Find a category node by id anywhere in the tree, or `null` if missing. */
export function findCategoryById(
  tree: readonly CategoryTreeNode[],
  id: string,
): CategoryTreeNode | null {
  for (const node of flattenCategories(tree)) {
    if (node.id === id) return node;
  }
  return null;
}

/** Find a category node by slug anywhere in the tree. */
export function findCategoryBySlug(
  tree: readonly CategoryTreeNode[],
  slug: string,
): CategoryTreeNode | null {
  for (const node of flattenCategories(tree)) {
    if (node.slug === slug) return node;
  }
  return null;
}

/**
 * Resolve a URL path like `["electronics", "phones", "smartphones"]` against
 * the tree, returning the ordered chain (root → leaf) of `CategoryTreeNode`s.
 * Returns `null` if any segment doesn't match a child of the previous level.
 *
 * This is the live-data equivalent of `lib/mock-data/categories.ts`'s
 * `resolveCategoryPath`. The function is pure: pass the same tree and the
 * same slug array, get the same answer.
 */
export function resolveCategoryPath(
  tree: readonly CategoryTreeNode[],
  slugs: readonly string[],
): CategoryTreeNode[] | null {
  const chain: CategoryTreeNode[] = [];
  let current: readonly CategoryTreeNode[] = tree;

  for (const slug of slugs) {
    const found = current.find((c) => c.slug === slug);
    if (!found) return null;
    chain.push(found);
    current = found.children;
  }

  return chain;
}

/**
 * Build the breadcrumb chain (root → ... → category) for a given category id,
 * by searching upward through the tree. Used by the product-detail page when
 * the API's `breadcrumb` field is preferred (it is — see ProductDetailView)
 * but also useful when only the categoryId is known (e.g. mapping a product
 * summary back to its category for the canonical product URL).
 *
 * Returns `[]` if the id isn't in the tree.
 */
export function getCategoryAncestors(
  tree: readonly CategoryTreeNode[],
  categoryId: string,
): CategoryTreeNode[] {
  // Walk depth-first, carrying the path we took. Stop at first match.
  function walk(
    nodes: readonly CategoryTreeNode[],
    path: CategoryTreeNode[],
  ): CategoryTreeNode[] | null {
    for (const node of nodes) {
      const here = [...path, node];
      if (node.id === categoryId) return here;
      if (node.children.length > 0) {
        const found = walk(node.children, here);
        if (found) return found;
      }
    }
    return null;
  }

  return walk(tree, []) ?? [];
}

/**
 * Build the canonical category URL from a chain of nodes. Always starts with
 * `/products/`. Caller usually obtains the chain from `resolveCategoryPath`
 * or `getCategoryAncestors`.
 */
export function categoryHref(chain: readonly CategoryTreeNode[]): string {
  if (chain.length === 0) return "/products";
  return "/products/" + chain.map((c) => c.slug).join("/");
}

/**
 * Build the canonical product URL given the chain of category ancestors and
 * the product slug. A product whose category chain is empty (root-less) gets
 * `/products/{slug}` — which the catch-all route resolves via its single-
 * segment product-slug fallback.
 */
export function productHref(
  chain: readonly { slug: string }[],
  productSlug: string,
): string {
  if (chain.length === 0) return `/products/${productSlug}`;
  return "/products/" + chain.map((c) => c.slug).join("/") + "/" + productSlug;
}
