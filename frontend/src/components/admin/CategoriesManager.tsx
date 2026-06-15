"use client";

/**
 * Admin category management — the real /admin/categories screen
 * (spec §"Управление на категории"): a hierarchical tree with create,
 * rename, re-image, move (parent change), sibling reorder, and the
 * cascade delete whose confirmation shows the affected sub-category and
 * product counts plus how many products sit in active orders (the spec's
 * „Разбирам последствията" gate).
 *
 * Data flows through the typed client in lib/admin/categories/. A flat 404
 * means the admin session expired → router.refresh() re-renders the admin
 * layout, which swaps in the AdminAuthGate (same contract as OrdersExplorer).
 *
 * Reordering uses accessible up/down buttons rather than drag-and-drop:
 * WCAG 2.2 SC 2.5.7 requires a single-pointer / keyboard alternative to
 * dragging anyway, and buttons are the alternative. (The spec's full
 * categories-AND-products interleaved „Наредба" view arrives with the
 * products admin slice; this slice reorders category siblings.)
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  FolderTree,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, slugify } from "@/lib/utils";
import {
  createCategory,
  deleteCategory,
  fetchAdminCategoryTree,
  fetchDeletionImpact,
  reorderCategories,
  updateCategory,
} from "@/lib/admin/categories/client";
import type {
  AdminCategoriesError,
  AdminCategoryDeletionImpact,
  AdminCategoryNode,
} from "@/lib/admin/categories/types";

// ─── Error copy ──────────────────────────────────────────────────────────────

function errorMessage(err: AdminCategoriesError): string {
  switch (err.kind) {
    case "slug_conflict":
      return "Вече съществува категория с този URL идентификатор на това ниво.";
    case "version_conflict":
      return "Категорията е променена в друг раздел. Списъкът е презареден — опитайте отново.";
    case "move_cycle":
      return "Категория не може да се премести в себе си или в своя подкатегория.";
    case "reorder_mismatch":
      return "Подредбата е остаряла. Списъкът е презареден — опитайте отново.";
    case "validation":
      return err.detail ?? "Невалидни данни.";
    case "category_not_found":
      return "Категорията не е намерена.";
    case "network":
      return "Връзката със сървъра пропадна. Опитайте отново.";
    case "not_admin":
      return "Сесията изтече. Презаредете страницата.";
    default:
      return err.detail ?? "Възникна неочаквана грешка.";
  }
}

// ─── Tree helpers (pure, client-side) ────────────────────────────────────────

/** Parents a node may be moved under: the whole tree minus the node's subtree. */
function eligibleParents(
  tree: AdminCategoryNode[],
  excludeId: string,
): { id: string; name: string; depth: number }[] {
  const out: { id: string; name: string; depth: number }[] = [];
  const walk = (nodes: AdminCategoryNode[], depth: number) => {
    for (const n of nodes) {
      if (n.id === excludeId) continue; // skip the node AND its descendants
      out.push({ id: n.id, name: n.name, depth });
      walk(n.children, depth + 1);
    }
  };
  walk(tree, 0);
  return out;
}

// ─── Dialog model ────────────────────────────────────────────────────────────

type DialogMode =
  | { type: "add-root" }
  | { type: "add-child"; parent: AdminCategoryNode }
  | { type: "edit"; node: AdminCategoryNode }
  | { type: "delete"; node: AdminCategoryNode }
  | null;

// ─── Root component ──────────────────────────────────────────────────────────

export default function CategoriesManager() {
  const router = useRouter();
  const [tree, setTree] = useState<AdminCategoryNode[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogMode>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetchAdminCategoryTree();
      if (cancelled) return;
      if (res.ok) {
        setTree(res.value.items);
        setLoadError(null);
      } else if (res.error.kind === "not_admin") {
        router.refresh();
      } else {
        setLoadError(errorMessage(res.error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function reload(): Promise<void> {
    const res = await fetchAdminCategoryTree();
    if (res.ok) {
      setTree(res.value.items);
      setLoadError(null);
    } else if (res.error.kind === "not_admin") {
      router.refresh();
    } else {
      setLoadError(errorMessage(res.error));
    }
  }

  function handleSessionMaybeExpired(err: AdminCategoriesError): boolean {
    if (err.kind === "not_admin") {
      router.refresh();
      return true;
    }
    return false;
  }

  async function handleReorder(
    siblings: AdminCategoryNode[],
    index: number,
    direction: -1 | 1,
  ): Promise<void> {
    const target = index + direction;
    if (target < 0 || target >= siblings.length) return;
    const ids = siblings.map((s) => s.id);
    const moved = ids[index]!;
    ids.splice(index, 1);
    ids.splice(target, 0, moved);
    const parentId = siblings[0]?.parentId ?? null;
    const res = await reorderCategories({ parentId, orderedIds: ids });
    setActionError(null);
    if (res.ok) {
      setTree(res.value.items);
    } else if (!handleSessionMaybeExpired(res.error)) {
      setActionError(errorMessage(res.error));
      await reload();
    }
  }

  const close = () => setDialog(null);

  return (
    <div>
      <div className="flex items-center justify-between mb-6 gap-3">
        <div>
          <h1 className="text-2xl font-bold">Категории</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Йерархична структура от категории и подкатегории
          </p>
        </div>
        <Button className="gap-2" onClick={() => setDialog({ type: "add-root" })}>
          <Plus className="w-4 h-4" />
          <span className="hidden sm:inline">Добави категория</span>
        </Button>
      </div>

      {actionError && (
        <div
          role="alert"
          className="mb-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
        >
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{actionError}</span>
        </div>
      )}

      {loadError ? (
        <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {loadError}
        </div>
      ) : tree === null ? (
        <div className="space-y-3" aria-hidden="true">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : tree.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-12 text-center">
          <FolderTree className="w-8 h-8 mx-auto text-muted-foreground" aria-hidden="true" />
          <p className="mt-3 text-sm text-muted-foreground">
            Все още няма категории. Добавете първата с бутона горе.
          </p>
        </div>
      ) : (
        <ul className="space-y-3 list-none pl-0">
          {tree.map((cat, i) => (
            <CategoryTreeItem
              key={cat.id}
              category={cat}
              siblings={tree}
              index={i}
              depth={0}
              onAddChild={(parent) => setDialog({ type: "add-child", parent })}
              onEdit={(node) => setDialog({ type: "edit", node })}
              onDelete={(node) => setDialog({ type: "delete", node })}
              onReorder={handleReorder}
            />
          ))}
        </ul>
      )}

      {/* Create / edit dialog */}
      <Dialog
        open={
          dialog?.type === "add-root" ||
          dialog?.type === "add-child" ||
          dialog?.type === "edit"
        }
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        {(dialog?.type === "add-root" ||
          dialog?.type === "add-child" ||
          dialog?.type === "edit") && (
          <CategoryFormDialog
            dialog={dialog}
            tree={tree ?? []}
            onSuccess={async () => {
              close();
              await reload();
            }}
            onSessionExpired={() => router.refresh()}
            onCancel={close}
          />
        )}
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog
        open={dialog?.type === "delete"}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        {dialog?.type === "delete" && (
          <DeleteDialog
            node={dialog.node}
            onSuccess={async () => {
              close();
              await reload();
            }}
            onSessionExpired={() => router.refresh()}
            onCancel={close}
          />
        )}
      </Dialog>
    </div>
  );
}

// ─── Tree item (recursive) ───────────────────────────────────────────────────

function CategoryTreeItem({
  category,
  siblings,
  index,
  depth,
  onAddChild,
  onEdit,
  onDelete,
  onReorder,
}: {
  category: AdminCategoryNode;
  siblings: AdminCategoryNode[];
  index: number;
  depth: number;
  onAddChild: (parent: AdminCategoryNode) => void;
  onEdit: (node: AdminCategoryNode) => void;
  onDelete: (node: AdminCategoryNode) => void;
  onReorder: (
    siblings: AdminCategoryNode[],
    index: number,
    direction: -1 | 1,
  ) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const children = category.children;
  const hasChildren = children.length > 0;

  return (
    <li
      className={cn(
        "rounded-lg border border-border bg-white overflow-hidden",
        depth > 0 && "ml-3 sm:ml-6 border-l-2 border-l-primary/20",
      )}
    >
      <div className="flex items-center justify-between px-3 sm:px-4 py-3 bg-muted/30 gap-2">
        <div className="flex items-start gap-2 min-w-0 flex-1">
          {hasChildren ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="p-0.5 hover:text-primary-strong transition-colors flex-shrink-0 mt-0.5"
              aria-label={expanded ? "Свий" : "Разгъни"}
              aria-expanded={expanded}
            >
              {expanded ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
            </button>
          ) : (
            <span className="w-5 flex-shrink-0" aria-hidden="true" />
          )}
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-sm leading-tight line-clamp-2">
              {category.name}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              <span className="font-mono">/{category.slug}</span>
              {" · "}
              {category.productCount} продукта
              {hasChildren ? ` · ${children.length} подкатегории` : ""}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            type="button"
            onClick={() => onReorder(siblings, index, -1)}
            disabled={index === 0}
            className="p-1.5 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label="Премести нагоре"
          >
            <ArrowUp className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onReorder(siblings, index, 1)}
            disabled={index === siblings.length - 1}
            className="p-1.5 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label="Премести надолу"
          >
            <ArrowDown className="w-3.5 h-3.5" />
          </button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-2 sm:px-3 gap-1"
            onClick={() => onAddChild(category)}
            aria-label="Добави подкатегория"
          >
            <Plus className="w-3.5 h-3.5" />
            <span className="hidden md:inline text-xs">Подкатегория</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-2 sm:px-3 gap-1"
            onClick={() => onEdit(category)}
            aria-label="Редактирай"
          >
            <Pencil className="w-3.5 h-3.5" />
            <span className="hidden md:inline text-xs">Редактирай</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-destructive hover:text-destructive hover:bg-destructive/10"
            onClick={() => onDelete(category)}
            aria-label="Изтрий"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {expanded && hasChildren && (
        <ul className="py-2 px-1 space-y-2 list-none pl-1">
          {children.map((child, ci) => (
            <CategoryTreeItem
              key={child.id}
              category={child}
              siblings={children}
              index={ci}
              depth={depth + 1}
              onAddChild={onAddChild}
              onEdit={onEdit}
              onDelete={onDelete}
              onReorder={onReorder}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// ─── Create / edit form ──────────────────────────────────────────────────────

function CategoryFormDialog({
  dialog,
  tree,
  onSuccess,
  onSessionExpired,
  onCancel,
}: {
  dialog:
    | { type: "add-root" }
    | { type: "add-child"; parent: AdminCategoryNode }
    | { type: "edit"; node: AdminCategoryNode };
  tree: AdminCategoryNode[];
  onSuccess: () => void | Promise<void>;
  onSessionExpired: () => void;
  onCancel: () => void;
}) {
  const isEdit = dialog.type === "edit";
  const editNode = dialog.type === "edit" ? dialog.node : null;

  const [name, setName] = useState(editNode?.name ?? "");
  // null = auto-derive from name; a string = the admin took over the field.
  const [manualSlug, setManualSlug] = useState<string | null>(
    editNode ? editNode.slug : null,
  );
  const [imageS3Key, setImageS3Key] = useState(editNode?.imageS3Key ?? "");
  // Edit-only: the parent the node is moved under (its current parent by default).
  const [parentId, setParentId] = useState<string | null>(
    editNode?.parentId ?? null,
  );
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const slug = manualSlug ?? slugify(name);
  const parentOptions = editNode ? eligibleParents(tree, editNode.id) : [];

  const title =
    dialog.type === "add-root"
      ? "Нова категория"
      : dialog.type === "add-child"
        ? `Нова подкатегория в „${dialog.parent.name}“`
        : `Редактиране на „${dialog.node.name}“`;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !slug.trim()) return;
    setSubmitting(true);
    setFormError(null);

    const result = isEdit
      ? await updateCategory(editNode!.id, {
          expectedUpdatedAt: editNode!.updatedAt,
          name: name.trim(),
          slug: slug.trim(),
          parentId,
          imageS3Key: imageS3Key.trim() || null,
        })
      : await createCategory({
          name: name.trim(),
          slug: slug.trim(),
          parentId: dialog.type === "add-child" ? dialog.parent.id : null,
          imageS3Key: imageS3Key.trim() || null,
        });

    setSubmitting(false);
    if (result.ok) {
      await onSuccess();
      return;
    }
    if (result.error.kind === "not_admin") {
      onSessionExpired();
      return;
    }
    setFormError(errorMessage(result.error));
  }

  return (
    <DialogContent className="sm:max-w-md">
      <form onSubmit={handleSubmit}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Slug се генерира автоматично от името. Снимката е по желание.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 my-4">
          <div>
            <Label htmlFor="cat-name">Име *</Label>
            <Input
              id="cat-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Напр. Електроника"
              className="mt-1"
              required
            />
          </div>
          <div>
            <Label htmlFor="cat-slug">Slug *</Label>
            <Input
              id="cat-slug"
              value={slug}
              onChange={(e) => setManualSlug(e.target.value)}
              placeholder="elektronika"
              className="mt-1 font-mono text-xs"
              required
            />
            <p className="text-xs text-muted-foreground mt-1">
              URL идентификатор (само латиница, цифри, тирета)
            </p>
          </div>
          {isEdit && (
            <div>
              <Label htmlFor="cat-parent">Бащина категория</Label>
              <select
                id="cat-parent"
                value={parentId ?? ""}
                onChange={(e) => setParentId(e.target.value || null)}
                className="mt-1 h-9 w-full text-sm border border-input rounded-md px-2 bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">— Главна категория —</option>
                {parentOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {`${"— ".repeat(p.depth)}${p.name}`}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground mt-1">
                Преместването мести и цялото съдържание на категорията.
              </p>
            </div>
          )}
          <div>
            <Label htmlFor="cat-image">S3 ключ на изображение</Label>
            <Input
              id="cat-image"
              value={imageS3Key}
              onChange={(e) => setImageS3Key(e.target.value)}
              placeholder="categories/elektronika.jpg"
              className="mt-1 font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground mt-1">
              По желание. Качването на файлове идва с управлението на продукти.
            </p>
          </div>
        </div>

        {formError && (
          <p role="alert" className="text-sm text-destructive mb-3">
            {formError}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
            Отказ
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? "Запазване…" : "Запази"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

// ─── Delete confirmation ─────────────────────────────────────────────────────

function DeleteDialog({
  node,
  onSuccess,
  onSessionExpired,
  onCancel,
}: {
  node: AdminCategoryNode;
  onSuccess: () => void | Promise<void>;
  onSessionExpired: () => void;
  onCancel: () => void;
}) {
  const [impact, setImpact] = useState<AdminCategoryDeletionImpact | null>(null);
  const [impactError, setImpactError] = useState<string | null>(null);
  const [understood, setUnderstood] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetchDeletionImpact(node.id);
      if (cancelled) return;
      if (res.ok) {
        setImpact(res.value);
      } else if (res.error.kind === "not_admin") {
        onSessionExpired();
      } else {
        setImpactError(errorMessage(res.error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [node.id, onSessionExpired]);

  async function handleDelete() {
    setSubmitting(true);
    setDeleteError(null);
    const res = await deleteCategory(node.id, node.updatedAt);
    setSubmitting(false);
    if (res.ok) {
      await onSuccess();
      return;
    }
    if (res.error.kind === "not_admin") {
      onSessionExpired();
      return;
    }
    setDeleteError(errorMessage(res.error));
  }

  const hasActiveOrders = (impact?.productsInActiveOrders ?? 0) > 0;

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Изтриване на „{node.name}“</DialogTitle>
        <DialogDescription>
          Това действие изтрива категорията и цялото ѝ съдържание — всички
          подкатегории и продукти в тях, рекурсивно.
        </DialogDescription>
      </DialogHeader>

      <div className="my-4 space-y-3 text-sm">
        {impactError ? (
          <p role="alert" className="text-destructive">{impactError}</p>
        ) : impact === null ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <>
            <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
              Ще бъдат изтрити:{" "}
              <strong>{impact.subcategoryCount}</strong> подкатегории и{" "}
              <strong>{impact.productCount}</strong> продукта.
            </div>
            {hasActiveOrders && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800"
              >
                <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <span>
                  <strong>{impact.productsInActiveOrders}</strong> от продуктите
                  в тази категория се намират в <strong>{impact.activeOrderCount}</strong>{" "}
                  активни поръчки. Историята на поръчките няма да бъде засегната
                  (данните са запазени като snapshot), но продуктите ще бъдат
                  изтрити от каталога.
                </span>
              </div>
            )}
            <label className="flex items-start gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={understood}
                onChange={(e) => setUnderstood(e.target.checked)}
                aria-label="Разбирам последствията"
                className="mt-0.5 h-4 w-4 rounded border-input accent-primary"
              />
              <span aria-hidden="true">Разбирам последствията</span>
            </label>
          </>
        )}
        {deleteError && (
          <p role="alert" className="text-destructive">{deleteError}</p>
        )}
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
          Отказ
        </Button>
        <Button
          type="button"
          variant="destructive"
          onClick={handleDelete}
          disabled={!understood || submitting || impact === null}
        >
          {submitting ? "Изтриване…" : "Изтрий"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
