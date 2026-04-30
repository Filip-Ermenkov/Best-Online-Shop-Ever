"use client";

import { useState, useMemo, useEffect } from "react";
import { categories as initialCategories } from "@/lib/mock-data/categories";
import { CategoryNode } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, ChevronRight, ChevronDown, Pencil, Trash2 } from "lucide-react";
import { cn, slugify } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// ─── Tree helpers ───────────────────────────────────────────────────────────

function insertChildRecursive(
  nodes: CategoryNode[],
  parentId: string,
  newNode: CategoryNode
): CategoryNode[] {
  return nodes.map((n) => {
    if (n.id === parentId) {
      return { ...n, children: [...n.children, newNode] };
    }
    if (n.children.length) {
      return { ...n, children: insertChildRecursive(n.children, parentId, newNode) };
    }
    return n;
  });
}

function updateNodeRecursive(
  nodes: CategoryNode[],
  targetId: string,
  update: Partial<CategoryNode>
): CategoryNode[] {
  return nodes.map((n) => {
    if (n.id === targetId) {
      return { ...n, ...update };
    }
    if (n.children.length) {
      return { ...n, children: updateNodeRecursive(n.children, targetId, update) };
    }
    return n;
  });
}

function archiveNodeRecursive(
  nodes: CategoryNode[],
  targetId: string
): CategoryNode[] {
  return nodes.map((n) => {
    if (n.id === targetId) {
      return { ...n, isArchived: true };
    }
    if (n.children.length) {
      return { ...n, children: archiveNodeRecursive(n.children, targetId) };
    }
    return n;
  });
}

// ─── Page ───────────────────────────────────────────────────────────────────

type DialogMode =
  | { type: "add-root" }
  | { type: "add-child"; parent: CategoryNode }
  | { type: "edit"; node: CategoryNode }
  | { type: "delete"; node: CategoryNode }
  | null;

export default function AdminCategoriesPage() {
  const [cats, setCats] = useState<CategoryNode[]>(initialCategories);
  const [dialog, setDialog] = useState<DialogMode>(null);

  const openAddRoot = () => setDialog({ type: "add-root" });
  const openAddChild = (parent: CategoryNode) => setDialog({ type: "add-child", parent });
  const openEdit = (node: CategoryNode) => setDialog({ type: "edit", node });
  const openDelete = (node: CategoryNode) => setDialog({ type: "delete", node });
  const close = () => setDialog(null);

  function handleSave(data: { name: string; slug: string; imageUrl: string }) {
    if (!dialog) return;

    if (dialog.type === "add-root") {
      const newNode: CategoryNode = {
        id: `cat-${Date.now()}`,
        slug: data.slug,
        name: data.name,
        parentId: null,
        order: cats.filter((c) => !c.isArchived).length + 1,
        isArchived: false,
        imageUrl: data.imageUrl || `https://placehold.co/600x400/1C1C2E/C9A96E?text=${encodeURIComponent(data.name)}`,
        children: [],
      };
      setCats([...cats, newNode]);
    } else if (dialog.type === "add-child") {
      const newNode: CategoryNode = {
        id: `sub-${Date.now()}`,
        slug: data.slug,
        name: data.name,
        parentId: dialog.parent.id,
        order: dialog.parent.children.filter((c) => !c.isArchived).length + 1,
        isArchived: false,
        imageUrl: data.imageUrl || `https://placehold.co/600x400/1C1C2E/C9A96E?text=${encodeURIComponent(data.name)}`,
        children: [],
      };
      setCats(insertChildRecursive(cats, dialog.parent.id, newNode));
    } else if (dialog.type === "edit") {
      setCats(updateNodeRecursive(cats, dialog.node.id, {
        name: data.name,
        slug: data.slug,
        imageUrl: data.imageUrl || dialog.node.imageUrl,
      }));
    }

    close();
  }

  function handleDelete() {
    if (dialog?.type === "delete") {
      setCats(archiveNodeRecursive(cats, dialog.node.id));
      close();
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6 gap-3">
        <div>
          <h1 className="text-2xl font-bold">Категории</h1>
          <p className="text-sm text-muted-foreground mt-1">Безкрайна йерархия от категории</p>
        </div>
        <Button className="gap-2" onClick={openAddRoot}>
          <Plus className="w-4 h-4" />
          <span className="hidden sm:inline">Добави категория</span>
        </Button>
      </div>

      <div className="space-y-3">
        {cats.filter((c) => !c.isArchived).map((cat) => (
          <CategoryTreeItem
            key={cat.id}
            category={cat}
            depth={0}
            onAddChild={openAddChild}
            onEdit={openEdit}
            onDelete={openDelete}
          />
        ))}
      </div>

      {/* Add / Edit dialog */}
      <Dialog
        open={dialog?.type === "add-root" || dialog?.type === "add-child" || dialog?.type === "edit"}
        onOpenChange={(open) => { if (!open) close(); }}
      >
        {(dialog?.type === "add-root" || dialog?.type === "add-child" || dialog?.type === "edit") && (
          <CategoryFormDialog dialog={dialog} onSave={handleSave} onCancel={close} />
        )}
      </Dialog>

      {/* Delete confirm dialog */}
      <Dialog
        open={dialog?.type === "delete"}
        onOpenChange={(open) => { if (!open) close(); }}
      >
        {dialog?.type === "delete" && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Изтриване на категория</DialogTitle>
              <DialogDescription>
                Сигурни ли сте, че искате да изтриете &ldquo;{dialog.node.name}&rdquo;? Категорията ще бъде преместена в архива и може да бъде възстановена оттам.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={close}>Отказ</Button>
              <Button variant="destructive" onClick={handleDelete}>Изтрий</Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

// ─── Tree item ──────────────────────────────────────────────────────────────

function CategoryTreeItem({
  category,
  depth,
  onAddChild,
  onEdit,
  onDelete,
}: {
  category: CategoryNode;
  depth: number;
  onAddChild: (parent: CategoryNode) => void;
  onEdit: (node: CategoryNode) => void;
  onDelete: (node: CategoryNode) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const activeChildren = category.children.filter((c) => !c.isArchived);
  const hasChildren = activeChildren.length > 0;

  return (
    <div
      className={cn(
        "rounded-lg border border-border bg-white overflow-hidden",
        depth > 0 && "ml-3 sm:ml-6 border-l-2 border-l-primary/20"
      )}
    >
      <div className="flex items-center justify-between px-3 sm:px-4 py-3 bg-muted/30 gap-2">
        <div className="flex items-start gap-2 min-w-0 flex-1">
          {hasChildren ? (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="p-0.5 hover:text-primary transition-colors flex-shrink-0 mt-0.5"
              aria-label={expanded ? "Свий" : "Разгъни"}
            >
              {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            </button>
          ) : (
            <span className="w-5 flex-shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-sm leading-tight line-clamp-2">{category.name}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {hasChildren ? `${activeChildren.length} подкатегории` : "Няма подкатегории"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
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
        <div className="py-2 px-1 space-y-2">
          {activeChildren
            .sort((a, b) => a.order - b.order)
            .map((child) => (
              <CategoryTreeItem
                key={child.id}
                category={child}
                depth={depth + 1}
                onAddChild={onAddChild}
                onEdit={onEdit}
                onDelete={onDelete}
              />
            ))}
        </div>
      )}
    </div>
  );
}

// ─── Form dialog ────────────────────────────────────────────────────────────

function CategoryFormDialog({
  dialog,
  onSave,
  onCancel,
}: {
  dialog: Exclude<DialogMode, null | { type: "delete"; node: CategoryNode }>;
  onSave: (data: { name: string; slug: string; imageUrl: string }) => void;
  onCancel: () => void;
}) {
  const initial = useMemo(() => {
    if (dialog.type === "edit") {
      return {
        name: dialog.node.name,
        slug: dialog.node.slug,
        imageUrl: dialog.node.imageUrl ?? "",
      };
    }
    return { name: "", slug: "", imageUrl: "" };
  }, [dialog]);

  const [name, setName] = useState(initial.name);
  const [slug, setSlug] = useState(initial.slug);
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(dialog.type === "edit");
  const [imageUrl, setImageUrl] = useState(initial.imageUrl);

  // Auto-generate slug from name until user manually edits it
  useEffect(() => {
    if (!slugManuallyEdited) {
      setSlug(slugify(name));
    }
  }, [name, slugManuallyEdited]);

  const title =
    dialog.type === "add-root"
      ? "Нова категория"
      : dialog.type === "add-child"
      ? `Нова подкатегория в ${dialog.parent.name}`
      : `Редактиране на ${dialog.node.name}`;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !slug.trim()) return;
    onSave({ name: name.trim(), slug: slug.trim(), imageUrl: imageUrl.trim() });
  }

  return (
    <DialogContent className="sm:max-w-md">
      <form onSubmit={handleSubmit}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Попълнете данните за категорията. Slug се генерира автоматично от името.
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
              autoFocus
              required
            />
          </div>
          <div>
            <Label htmlFor="cat-slug">Slug *</Label>
            <Input
              id="cat-slug"
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
                setSlugManuallyEdited(true);
              }}
              placeholder="elektronika"
              className="mt-1 font-mono text-xs"
              required
            />
            <p className="text-xs text-muted-foreground mt-1">
              URL идентификатор (само латиница, цифри, тирета)
            </p>
          </div>
          <div>
            <Label htmlFor="cat-image">URL на изображение</Label>
            <Input
              id="cat-image"
              type="url"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              placeholder="https://..."
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              По желание — ще се използва placeholder ако е празно
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>Отказ</Button>
          <Button type="submit">Запази</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
