"use client";

/**
 * Admin product list — the real /admin/products screen (spec §"Управление на
 * продукти"): search, filters (category / stock / archive status), sort, offset
 * pagination (25/page, controls top AND bottom like OrdersExplorer), and an
 * accessible within-category reorder.
 *
 * Data flows through the typed client in lib/admin/products/. A flat 404 from
 * the admin surface means the session expired — `router.refresh()` re-renders
 * the admin layout, which swaps in the AdminAuthGate (same contract as
 * OrdersExplorer / CategoriesManager).
 *
 * Reordering uses up/down buttons, never drag (WCAG 2.2 SC 2.5.7 — matching
 * CategoriesManager). It is only offered when the list is unambiguously one
 * full category layer: a single category is selected, status = active, no
 * search, and the layer fits on one page — the exact set the backend's reorder
 * endpoint requires (it rejects a partial id set with 409).
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowDown, ArrowUp, Plus, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatCents, sanitizeImageUrl } from "@/lib/utils";
import {
  fetchAdminProducts,
  reorderProducts,
} from "@/lib/admin/products/client";
import { fetchAdminCategoryTree } from "@/lib/admin/categories/client";
import type {
  AdminProductsError,
  AdminProductSummary,
  AdminProductListQuery,
} from "@/lib/admin/products/types";
import type { AdminCategoryNode } from "@/lib/admin/categories/types";

const PAGE_SIZE = 25;

const STOCK_BADGE: Record<string, { label: string; className: string }> = {
  in_stock: { label: "В наличност", className: "bg-green-100 text-green-700 border-green-200" },
  out_of_stock: { label: "Изчерпано", className: "bg-red-100 text-red-700 border-red-200" },
};

const selectClass =
  "h-9 text-sm border border-input rounded-md px-2 bg-background focus:outline-none focus:ring-2 focus:ring-ring";

function errorMessage(err: AdminProductsError): string {
  switch (err.kind) {
    case "reorder_mismatch":
      return "Подредбата е остаряла. Списъкът е презареден — опитайте отново.";
    case "version_conflict":
      return "Продуктът е променен в друг раздел. Списъкът е презареден.";
    case "validation":
      return err.detail ?? "Невалидни данни.";
    case "network":
      return "Връзката със сървъра пропадна. Опитайте отново.";
    case "not_admin":
      return "Сесията изтече. Презаредете страницата.";
    case "product_not_found":
      return "Продуктът не е намерен.";
    default:
      return err.detail ?? "Възникна неочаквана грешка.";
  }
}

/** Flatten the category tree into indented options for the filter <select>. */
function flattenTree(
  nodes: AdminCategoryNode[],
  depth = 0,
): { id: string; name: string; depth: number }[] {
  const out: { id: string; name: string; depth: number }[] = [];
  for (const n of nodes) {
    out.push({ id: n.id, name: n.name, depth });
    if (n.children.length > 0) out.push(...flattenTree(n.children, depth + 1));
  }
  return out;
}

interface Filters {
  status: "active" | "archived" | "all";
  categoryId: string; // "" = all categories
  stockStatus: "" | "in_stock" | "out_of_stock";
  sort: NonNullable<AdminProductListQuery["sort"]>;
  q: string;
}

const DEFAULT_FILTERS: Filters = {
  status: "active",
  categoryId: "",
  stockStatus: "",
  sort: "newest",
  q: "",
};

export default function ProductsManager() {
  const router = useRouter();
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [page, setPage] = useState(1);
  const [searchDraft, setSearchDraft] = useState("");
  const [items, setItems] = useState<AdminProductSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [categories, setCategories] = useState<{ id: string; name: string; depth: number }[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  // Category options for the filter (best-effort — the list still works without).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetchAdminCategoryTree();
      if (cancelled) return;
      if (res.ok) setCategories(flattenTree(res.value.items));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const query: AdminProductListQuery = {
        page,
        pageSize: PAGE_SIZE,
        status: filters.status,
        sort: filters.sort,
        ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
        ...(filters.stockStatus ? { stockStatus: filters.stockStatus } : {}),
        ...(filters.q ? { q: filters.q } : {}),
      };
      const res = await fetchAdminProducts(query);
      if (cancelled) return;
      if (res.ok) {
        setItems(res.value.items);
        setTotal(res.value.total);
        setTotalPages(res.value.totalPages);
        setLoadError(null);
        return;
      }
      if (res.error.kind === "not_admin") {
        router.refresh();
        return;
      }
      setLoadError(errorMessage(res.error));
    })();
    return () => {
      cancelled = true;
    };
  }, [filters, page, reloadKey, router]);

  function patchFilters(patch: Partial<Filters>) {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  }

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    patchFilters({ q: searchDraft.trim() });
  }

  // Reorder is only safe when the displayed list is exactly one full category
  // layer (the backend reorder endpoint demands the complete id set).
  const reorderEligible =
    filters.categoryId !== "" &&
    filters.status === "active" &&
    filters.q === "" &&
    total <= PAGE_SIZE &&
    (items?.length ?? 0) > 1;

  // When reordering, render in displayOrder (the list API doesn't sort by it).
  const displayed =
    reorderEligible && items
      ? [...items].sort((a, b) => a.displayOrder - b.displayOrder)
      : (items ?? []);

  async function handleReorder(index: number, direction: -1 | 1) {
    if (!reorderEligible) return;
    const target = index + direction;
    if (target < 0 || target >= displayed.length) return;
    const ids = displayed.map((p) => p.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(target, 0, moved!);
    setActionError(null);
    const res = await reorderProducts({ categoryId: filters.categoryId, orderedIds: ids });
    if (res.ok) {
      setReloadKey((k) => k + 1); // refetch to pick up the new order
    } else if (res.error.kind === "not_admin") {
      router.refresh();
    } else {
      setActionError(errorMessage(res.error));
      setReloadKey((k) => k + 1);
    }
  }

  const newProductHref = filters.categoryId
    ? `/admin/products/new?categoryId=${encodeURIComponent(filters.categoryId)}`
    : "/admin/products/new";

  return (
    <div>
      <div className="flex items-center justify-between mb-6 gap-3">
        <div>
          <h1 className="text-2xl font-bold">Продукти</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {items === null ? "Зареждане…" : `${total} ${total === 1 ? "продукт" : "продукта"}`}
          </p>
        </div>
        <ButtonLink className="gap-2" href={newProductHref}>
          <Plus className="w-4 h-4" />
          <span className="hidden sm:inline">Добави продукт</span>
        </ButtonLink>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 mb-4">
        <form onSubmit={submitSearch} className="flex items-center gap-2 flex-1 min-w-[200px]">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden="true" />
            <Input
              type="search"
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              placeholder="Търси по име или SKU"
              aria-label="Търсене на продукти"
              className="pl-8 h-9"
            />
          </div>
          <Button type="submit" variant="outline" size="sm" className="h-9">
            Търси
          </Button>
        </form>

        <div className="flex flex-col gap-1">
          <label htmlFor="filter-category" className="text-xs text-muted-foreground">Категория</label>
          <select
            id="filter-category"
            value={filters.categoryId}
            onChange={(e) => patchFilters({ categoryId: e.target.value })}
            className={selectClass}
          >
            <option value="">Всички категории</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {"— ".repeat(c.depth)}
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="filter-stock" className="text-xs text-muted-foreground">Наличност</label>
          <select
            id="filter-stock"
            value={filters.stockStatus}
            onChange={(e) => patchFilters({ stockStatus: e.target.value as Filters["stockStatus"] })}
            className={selectClass}
          >
            <option value="">Всякаква</option>
            <option value="in_stock">В наличност</option>
            <option value="out_of_stock">Изчерпано</option>
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="filter-status" className="text-xs text-muted-foreground">Статус</label>
          <select
            id="filter-status"
            value={filters.status}
            onChange={(e) => patchFilters({ status: e.target.value as Filters["status"] })}
            className={selectClass}
          >
            <option value="active">Активни</option>
            <option value="archived">Архивирани</option>
            <option value="all">Всички</option>
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="filter-sort" className="text-xs text-muted-foreground">Подреди</label>
          <select
            id="filter-sort"
            value={filters.sort}
            onChange={(e) => patchFilters({ sort: e.target.value as Filters["sort"] })}
            className={selectClass}
          >
            <option value="newest">Най-нови</option>
            <option value="oldest">Най-стари</option>
            <option value="price_asc">Цена ↑</option>
            <option value="price_desc">Цена ↓</option>
            <option value="name">Име (А-Я)</option>
          </select>
        </div>
      </div>

      {actionError && (
        <div role="alert" className="mb-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{actionError}</span>
        </div>
      )}

      {reorderEligible && (
        <div className="rounded-md bg-primary/10 border border-primary/20 px-3 py-2 mb-4 text-xs text-foreground/80">
          Подредете продуктите в категорията със стрелките ↑↓.
        </div>
      )}

      {loadError ? (
        <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {loadError}
        </div>
      ) : items === null ? (
        <div className="space-y-3" aria-hidden="true">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : displayed.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
          Няма продукти за тези филтри.
        </div>
      ) : (
        <>
          <PaginationBar page={page} totalPages={totalPages} onPage={setPage} />

          {/* Desktop table */}
          <div className="rounded-lg border border-border bg-white overflow-hidden hidden md:block mt-3">
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[680px]">
                <thead className="bg-muted/50 border-b border-border">
                  <tr>
                    {reorderEligible && <th className="w-16 px-2 py-3" aria-label="Ред"></th>}
                    <th className="text-left px-4 py-3 font-medium">Продукт</th>
                    <th className="text-left px-4 py-3 font-medium">SKU</th>
                    <th className="text-left px-4 py-3 font-medium">Категория</th>
                    <th className="text-left px-4 py-3 font-medium">Наличност</th>
                    <th className="text-right px-4 py-3 font-medium">Цена</th>
                    <th className="px-4 py-3">
                      <span className="sr-only">Действия</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {displayed.map((p, i) => (
                    <ProductRow
                      key={p.id}
                      product={p}
                      index={i}
                      count={displayed.length}
                      reorderable={reorderEligible}
                      onReorder={handleReorder}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden space-y-3 mt-3">
            {displayed.map((p, i) => (
              <ProductCard
                key={p.id}
                product={p}
                index={i}
                count={displayed.length}
                reorderable={reorderEligible}
                onReorder={handleReorder}
              />
            ))}
          </div>

          <div className="mt-4">
            <PaginationBar page={page} totalPages={totalPages} onPage={setPage} />
          </div>
        </>
      )}
    </div>
  );
}

// ─── Pagination ───────────────────────────────────────────────────────────────

function PaginationBar({
  page,
  totalPages,
  onPage,
}: {
  page: number;
  totalPages: number;
  onPage: (p: number) => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <Button
        variant="outline"
        size="sm"
        onClick={() => onPage(Math.max(1, page - 1))}
        disabled={page <= 1}
      >
        Назад
      </Button>
      <span className="text-muted-foreground" aria-live="polite">
        Страница {page} от {totalPages}
      </span>
      <Button
        variant="outline"
        size="sm"
        onClick={() => onPage(Math.min(totalPages, page + 1))}
        disabled={page >= totalPages}
      >
        Напред
      </Button>
    </div>
  );
}

// ─── Reorder controls (shared by row + card) ──────────────────────────────────

function ReorderButtons({
  index,
  count,
  onReorder,
}: {
  index: number;
  count: number;
  onReorder: (index: number, direction: -1 | 1) => void;
}) {
  return (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        onClick={() => onReorder(index, -1)}
        disabled={index === 0}
        className="p-1.5 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
        aria-label="Премести нагоре"
      >
        <ArrowUp className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        onClick={() => onReorder(index, 1)}
        disabled={index === count - 1}
        className="p-1.5 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
        aria-label="Премести надолу"
      >
        <ArrowDown className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

// ─── Desktop row ──────────────────────────────────────────────────────────────

function ProductRow({
  product,
  index,
  count,
  reorderable,
  onReorder,
}: {
  product: AdminProductSummary;
  index: number;
  count: number;
  reorderable: boolean;
  onReorder: (index: number, direction: -1 | 1) => void;
}) {
  const stock = STOCK_BADGE[product.stockStatus];
  const src = sanitizeImageUrl(product.primaryImageUrl);
  return (
    <tr className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors">
      {reorderable && (
        <td className="px-2 py-3">
          <ReorderButtons index={index} count={count} onReorder={onReorder} />
        </td>
      )}
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="w-10 h-10 rounded bg-muted overflow-hidden flex-shrink-0 flex items-center justify-center">
            {src ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={src} alt={product.name} className="w-full h-full object-cover" />
            ) : (
              <span className="text-[9px] text-muted-foreground">няма</span>
            )}
          </span>
          <span className="font-medium line-clamp-1 min-w-0">{product.name}</span>
          {product.isNew && <Badge className="text-[10px] px-1 py-0 h-4 bg-primary">НОВО</Badge>}
          {product.archived && (
            <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 border-amber-300 text-amber-700">
              Архивиран
            </Badge>
          )}
        </div>
      </td>
      <td className="px-4 py-3 text-muted-foreground font-mono text-xs">{product.code}</td>
      <td className="px-4 py-3 text-muted-foreground text-xs">{product.categoryName ?? "—"}</td>
      <td className="px-4 py-3">
        {stock && (
          <Badge variant="outline" className={stock.className}>
            {stock.label}
          </Badge>
        )}
      </td>
      <td className="px-4 py-3 text-right font-semibold">{formatCents(product.priceCents)}</td>
      <td className="px-4 py-3 text-right">
        <ButtonLink variant="ghost" size="sm" href={`/admin/products/${product.id}`}>
          Редактирай
        </ButtonLink>
      </td>
    </tr>
  );
}

// ─── Mobile card ──────────────────────────────────────────────────────────────

function ProductCard({
  product,
  index,
  count,
  reorderable,
  onReorder,
}: {
  product: AdminProductSummary;
  index: number;
  count: number;
  reorderable: boolean;
  onReorder: (index: number, direction: -1 | 1) => void;
}) {
  const stock = STOCK_BADGE[product.stockStatus];
  const src = sanitizeImageUrl(product.primaryImageUrl);
  return (
    <div className={cn("rounded-lg border border-border bg-white overflow-hidden", product.archived && "opacity-80")}>
      <div className="flex items-stretch gap-2">
        {reorderable && (
          <div className="flex flex-col items-center justify-center px-1 bg-muted/40">
            <ReorderButtons index={index} count={count} onReorder={onReorder} />
          </div>
        )}
        <ButtonLink
          variant="ghost"
          href={`/admin/products/${product.id}`}
          className="flex items-center gap-3 p-3 flex-1 min-w-0 h-auto justify-start font-normal"
        >
          <div className="w-14 h-14 rounded bg-muted overflow-hidden flex-shrink-0 flex items-center justify-center">
            {src ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={src} alt={product.name} className="w-full h-full object-cover" />
            ) : (
              <span className="text-[9px] text-muted-foreground">няма</span>
            )}
          </div>
          <div className="flex-1 min-w-0 text-left">
            <p className="font-medium text-sm line-clamp-2 leading-tight">{product.name}</p>
            <p className="text-[11px] text-muted-foreground font-mono mt-0.5">{product.code}</p>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              {stock && (
                <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${stock.className}`}>
                  {stock.label}
                </Badge>
              )}
              {product.isNew && <Badge className="text-[10px] px-1 py-0 h-4 bg-primary">НОВО</Badge>}
              {product.archived && (
                <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 border-amber-300 text-amber-700">
                  Архивиран
                </Badge>
              )}
              <span className="text-sm font-semibold">{formatCents(product.priceCents)}</span>
            </div>
          </div>
        </ButtonLink>
      </div>
    </div>
  );
}
