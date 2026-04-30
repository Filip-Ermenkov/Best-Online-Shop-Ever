"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { products } from "@/lib/mock-data/products";
import { categories, flattenCategories, getCategoryAncestors } from "@/lib/mock-data/categories";
import { formatPrice } from "@/lib/utils";
import { ButtonLink } from "@/components/ui/button-link";
import { Badge } from "@/components/ui/badge";
import { Plus, GripVertical } from "lucide-react";
import type { Product } from "@/lib/types";
import {
  DndContext,
  DragEndEvent,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

const stockBadge: Record<string, { label: string; className: string }> = {
  in_stock: { label: "В наличност", className: "bg-green-100 text-green-700 border-green-200" },
  out_of_stock: { label: "Изчерпано", className: "bg-red-100 text-red-700 border-red-200" },
};

export default function AdminProductsPage() {
  const [filterCategoryId, setFilterCategoryId] = useState<string>("");
  const [orderedProducts, setOrderedProducts] = useState<Product[]>(products);

  const allFlat = flattenCategories(categories);
  const activeProducts = orderedProducts.filter((p) => !p.isArchived);

  const filtered = useMemo(
    () =>
      filterCategoryId
        ? activeProducts
            .filter((p) => p.categoryId === filterCategoryId)
            .sort((a, b) => a.displayOrder - b.displayOrder)
        : activeProducts,
    [activeProducts, filterCategoryId]
  );

  const sortable = Boolean(filterCategoryId);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = filtered.findIndex((p) => p.id === active.id);
    const newIndex = filtered.findIndex((p) => p.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;

    const reordered = arrayMove(filtered, oldIndex, newIndex);
    // Reassign displayOrder based on new position (1, 2, 3, ...)
    const newOrderById = new Map(reordered.map((p, i) => [p.id, i + 1]));
    setOrderedProducts((prev) =>
      prev.map((p) =>
        newOrderById.has(p.id) ? { ...p, displayOrder: newOrderById.get(p.id)! } : p
      )
    );
  }

  const newProductHref = filterCategoryId
    ? `/admin/products/new?categoryId=${filterCategoryId}`
    : "/admin/products/new";

  return (
    <div>
      <div className="flex items-center justify-between mb-6 gap-3">
        <div>
          <h1 className="text-2xl font-bold">Продукти</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {activeProducts.length} активни продукта
          </p>
        </div>
        <ButtonLink className="gap-2" href={newProductHref}>
          <Plus className="w-4 h-4" />
          <span className="hidden sm:inline">Добави продукт</span>
        </ButtonLink>
      </div>

      {/* Category filter */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 mb-4">
        <label htmlFor="cat-filter" className="text-sm font-medium whitespace-nowrap">
          Филтър по категория:
        </label>
        <select
          id="cat-filter"
          value={filterCategoryId}
          onChange={(e) => setFilterCategoryId(e.target.value)}
          className="border border-border rounded-md px-3 py-1.5 text-sm bg-white max-w-full"
        >
          <option value="">Всички категории</option>
          {allFlat.map((c) => {
            const depth = getCategoryAncestors(c.id).length - 1;
            return (
              <option key={c.id} value={c.id}>
                {"—".repeat(depth)} {c.name}
              </option>
            );
          })}
        </select>
      </div>

      {sortable && (
        <div className="rounded-md bg-primary/10 border border-primary/20 px-3 py-2 mb-4 text-xs text-foreground/80">
          Плъзнете продуктите с дръжката <GripVertical className="inline w-3 h-3" />, за да промените реда им в категорията.
        </div>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext
          items={filtered.map((p) => p.id)}
          strategy={verticalListSortingStrategy}
        >
          {/* Desktop table */}
          <div className="rounded-lg border border-border bg-white overflow-hidden hidden md:block">
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[650px]">
                <thead className="bg-muted/50 border-b border-border">
                  <tr>
                    {sortable && <th className="w-10 px-2 py-3"></th>}
                    <th className="text-left px-4 py-3 font-medium">Продукт</th>
                    <th className="text-left px-4 py-3 font-medium">Код</th>
                    <th className="text-left px-4 py-3 font-medium">Категория</th>
                    <th className="text-left px-4 py-3 font-medium">Наличност</th>
                    <th className="text-right px-4 py-3 font-medium">Цена</th>
                    {sortable && <th className="w-16 text-center px-2 py-3 font-medium">Ред</th>}
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((p) => (
                    <SortableProductRow key={p.id} product={p} sortable={sortable} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile card list */}
          <div className="md:hidden space-y-3">
            {filtered.map((p) => (
              <SortableProductCard key={p.id} product={p} sortable={sortable} />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}

// ─── Sortable desktop row ───────────────────────────────────────────────────

function SortableProductRow({ product, sortable }: { product: Product; sortable: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: product.id,
    disabled: !sortable,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const stock = stockBadge[product.stockStatus];
  const ancestors = getCategoryAncestors(product.categoryId);
  const categoryPath = ancestors.map((c) => c.name).join(" > ");

  return (
    <tr
      ref={setNodeRef}
      style={style}
      className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors"
    >
      {sortable && (
        <td className="px-2 py-3 text-center">
          <button
            {...attributes}
            {...listeners}
            className="p-1 cursor-grab active:cursor-grabbing hover:bg-muted rounded touch-none"
            aria-label="Плъзни за пренареждане"
          >
            <GripVertical className="w-4 h-4 text-muted-foreground" />
          </button>
        </td>
      )}
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded bg-muted overflow-hidden flex-shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={product.images[0]?.url} alt={product.name} className="w-full h-full object-cover" />
          </div>
          <div className="min-w-0">
            <p className="font-medium line-clamp-1">{product.name}</p>
            {product.isNew && <Badge className="text-[10px] px-1 py-0 h-4 bg-primary">НОВО</Badge>}
          </div>
        </div>
      </td>
      <td className="px-4 py-3 text-muted-foreground font-mono text-xs">{product.code}</td>
      <td className="px-4 py-3 text-muted-foreground text-xs">{categoryPath || "—"}</td>
      <td className="px-4 py-3">
        <Badge variant="outline" className={stock.className}>{stock.label}</Badge>
      </td>
      <td className="px-4 py-3 text-right font-semibold">{formatPrice(product.price)}</td>
      {sortable && (
        <td className="px-2 py-3 text-center text-xs text-muted-foreground font-mono">
          {product.displayOrder}
        </td>
      )}
      <td className="px-4 py-3">
        <ButtonLink variant="ghost" size="sm" href={`/admin/products/${product.id}`}>
          Редактирай
        </ButtonLink>
      </td>
    </tr>
  );
}

// ─── Sortable mobile card ───────────────────────────────────────────────────

function SortableProductCard({ product, sortable }: { product: Product; sortable: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: product.id,
    disabled: !sortable,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const stock = stockBadge[product.stockStatus];

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-stretch gap-2 rounded-lg border border-border bg-white overflow-hidden"
    >
      {sortable && (
        <button
          {...attributes}
          {...listeners}
          className="flex items-center px-2 bg-muted/40 cursor-grab active:cursor-grabbing touch-none flex-shrink-0"
          aria-label="Плъзни за пренареждане"
        >
          <GripVertical className="w-4 h-4 text-muted-foreground" />
        </button>
      )}
      <Link
        href={`/admin/products/${product.id}`}
        className="flex items-center gap-3 p-3 hover:bg-muted/20 transition-colors flex-1 min-w-0"
      >
        <div className="w-14 h-14 rounded bg-muted overflow-hidden flex-shrink-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={product.images[0]?.url} alt={product.name} className="w-full h-full object-cover" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-medium text-sm line-clamp-2 leading-tight">{product.name}</p>
          <p className="text-[11px] text-muted-foreground font-mono mt-0.5">{product.code}</p>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${stock.className}`}>
              {stock.label}
            </Badge>
            <span className="text-sm font-semibold">{formatPrice(product.price)}</span>
          </div>
        </div>
        {sortable && (
          <span className="text-[11px] text-muted-foreground font-mono self-start">
            #{product.displayOrder}
          </span>
        )}
      </Link>
    </div>
  );
}
