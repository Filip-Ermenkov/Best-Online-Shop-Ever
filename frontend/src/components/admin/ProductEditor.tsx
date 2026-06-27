"use client";

/**
 * Admin product create / edit form — the real editor behind /admin/products/new
 * and /admin/products/[id] (spec §"Управление на продукти"). One component, two
 * modes, so the field set, validation, and the image widget never drift between
 * "create" and "edit".
 *
 * It is wired to the real `/admin/products` CRUD (lib/admin/products/client) and
 * embeds the reusable ImageUploadField — the first real consumer of the
 * presigned-POST upload pipeline (roadmap item 46), so product images are now
 * uploaded, not pasted as raw URLs.
 *
 * Model note: this matches the backend's single-SKU product (one `code`, one
 * `stockStatus`, an ordered image set). The mock's per-product *variant matrix*
 * and `stockQuantity` are intentionally dropped — the API doesn't model them
 * (a `product_variants` child table is a documented §16 future door). Editing
 * is optimistic-locked: the form carries the `updatedAt` it loaded as
 * `expectedUpdatedAt`, and a concurrent change comes back as a 409 the UI
 * surfaces with a reload prompt.
 */

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Check, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
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
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { sanitizeImageUrl, slugify } from "@/lib/utils";
import {
  createProduct,
  deleteProduct,
  fetchAdminProduct,
  restoreProduct,
  updateProduct,
} from "@/lib/admin/products/client";
import { fetchAdminCategoryTree } from "@/lib/admin/categories/client";
import type {
  AdminProductDetail,
  AdminProductsError,
  ProductCreateInput,
  ProductImageInput,
  ProductUpdateInput,
} from "@/lib/admin/products/types";
import type { AdminCategoryNode } from "@/lib/admin/categories/types";
import ImageUploadField, { type ImageDraft } from "./ImageUploadField";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const selectClass =
  "mt-1 w-full text-sm border border-input rounded-md px-3 py-2 bg-background focus:outline-none focus:ring-2 focus:ring-ring";

function errorMessage(err: AdminProductsError): string {
  switch (err.kind) {
    case "slug_conflict":
      return "Вече съществува продукт с този URL идентификатор (възможно е да е архивиран — възстановете го).";
    case "code_conflict":
      return "Вече съществува продукт с този SKU (възможно е да е архивиран — възстановете го).";
    case "version_conflict":
      return "Продуктът е променен в друг раздел, докато редактирахте. Презаредете и опитайте отново.";
    case "validation":
      return err.detail ?? "Невалидни данни. Проверете полетата.";
    case "product_not_found":
      return "Продуктът не е намерен.";
    case "network":
      return "Връзката със сървъра пропадна. Опитайте отново.";
    case "not_admin":
      return "Сесията изтече. Презаредете страницата.";
    default:
      return err.detail ?? "Възникна неочаквана грешка.";
  }
}

/** Parse a "549.99"/"549,99" price string into integer cents, or null. */
function priceToCents(input: string): number | null {
  const normalized = input.replace(",", ".").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const cents = Math.round(Number.parseFloat(normalized) * 100);
  return Number.isFinite(cents) && cents >= 0 ? cents : null;
}

function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Flatten the category tree into indented options. */
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

interface FormState {
  name: string;
  code: string;
  slug: string;
  description: string;
  price: string;
  categoryId: string; // "" = uncategorised
  stockStatus: "in_stock" | "out_of_stock";
  isNew: boolean;
}

const EMPTY_FORM: FormState = {
  name: "",
  code: "",
  slug: "",
  description: "",
  price: "",
  categoryId: "",
  stockStatus: "in_stock",
  isNew: true,
};

export default function ProductEditor({
  mode,
  productId,
}: {
  mode: "create" | "edit";
  productId?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [form, setForm] = useState<FormState>(() =>
    mode === "create"
      ? { ...EMPTY_FORM, categoryId: searchParams.get("categoryId") ?? "" }
      : EMPTY_FORM,
  );
  const [images, setImages] = useState<ImageDraft[]>([]);
  const [categories, setCategories] = useState<{ id: string; name: string; depth: number }[]>([]);

  // Edit-mode loaded record (the optimistic-lock token + archived flag live here).
  const [loaded, setLoaded] = useState<AdminProductDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(mode === "edit");

  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Category options (best-effort).
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

  // Edit mode: load the product.
  useEffect(() => {
    if (mode !== "edit" || !productId) return;
    let cancelled = false;
    (async () => {
      const res = await fetchAdminProduct(productId);
      if (cancelled) return;
      setLoading(false);
      if (res.ok) {
        const p = res.value;
        setLoaded(p);
        setForm({
          name: p.name,
          code: p.code,
          slug: p.slug,
          description: p.description,
          price: centsToInput(p.priceCents),
          categoryId: p.categoryId ?? "",
          stockStatus: p.stockStatus,
          isNew: p.isNew,
        });
        setImages(
          p.images.map((img) => ({
            s3Key: img.s3Key,
            altText: img.alt,
            previewUrl: sanitizeImageUrl(img.url),
          })),
        );
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
  }, [mode, productId, router]);

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function imagesPayload(): ProductImageInput[] {
    return images
      .filter((img) => img.s3Key.trim() !== "")
      .map((img) => ({
        s3Key: img.s3Key.trim(),
        ...(img.altText.trim() ? { altText: img.altText.trim() } : {}),
      }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    if (!form.name.trim()) return setFormError("Въведете наименование.");
    if (!form.code.trim()) return setFormError("Въведете SKU (продуктов код).");
    const priceCents = priceToCents(form.price);
    if (priceCents === null) return setFormError("Въведете валидна цена (напр. 549.99).");

    const categoryId = form.categoryId === "" ? null : form.categoryId;
    setSubmitting(true);

    if (mode === "create") {
      const payload: ProductCreateInput = {
        name: form.name.trim(),
        code: form.code.trim(),
        slug: form.slug.trim() || undefined,
        description: form.description.trim() || undefined,
        priceCents,
        categoryId,
        stockStatus: form.stockStatus,
        // checked → omit (backend defaults to a 30-day badge); unchecked → null.
        ...(form.isNew ? {} : { newUntil: null }),
        ...(imagesPayload().length > 0 ? { images: imagesPayload() } : {}),
      };
      const res = await createProduct(payload);
      setSubmitting(false);
      if (res.ok) {
        finishAndLeave();
        return;
      }
      if (res.error.kind === "not_admin") return router.refresh();
      setFormError(errorMessage(res.error));
      return;
    }

    // Edit
    if (!loaded) {
      setSubmitting(false);
      return;
    }
    const payload: ProductUpdateInput = {
      expectedUpdatedAt: loaded.updatedAt,
      name: form.name.trim(),
      code: form.code.trim(),
      description: form.description.trim(),
      priceCents,
      categoryId,
      stockStatus: form.stockStatus,
      images: imagesPayload(),
      ...(form.slug.trim() && form.slug.trim() !== loaded.slug
        ? { slug: form.slug.trim() }
        : {}),
      ...newUntilPatch(form.isNew, loaded.isNew),
    };
    const res = await updateProduct(loaded.id, payload);
    setSubmitting(false);
    if (res.ok) {
      finishAndLeave();
      return;
    }
    if (res.error.kind === "not_admin") return router.refresh();
    setFormError(errorMessage(res.error));
  }

  function finishAndLeave() {
    setSaved(true);
    setTimeout(() => {
      router.push("/admin/products");
      router.refresh();
    }, 700);
  }

  async function handleRestore() {
    if (!loaded) return;
    setFormError(null);
    const res = await restoreProduct(loaded.id);
    if (res.ok) {
      setLoaded(res.value);
      setForm((f) => ({ ...f, categoryId: res.value.categoryId ?? "" }));
    } else if (res.error.kind === "not_admin") {
      router.refresh();
    } else {
      setFormError(errorMessage(res.error));
    }
  }

  // ── Render ──

  if (mode === "edit" && loading) {
    return (
      <div className="max-w-2xl space-y-4">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (mode === "edit" && loadError && !loaded) {
    return (
      <div className="max-w-2xl">
        <ButtonLink variant="ghost" size="sm" href="/admin/products" className="gap-1 mb-4">
          <ArrowLeft className="w-4 h-4" /> Назад
        </ButtonLink>
        <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {loadError}
        </div>
      </div>
    );
  }

  const archived = loaded?.archived ?? false;

  return (
    <div className="max-w-2xl">
      <div className="flex items-center justify-between gap-3 mb-6 flex-wrap">
        <div className="flex items-center gap-3">
          <ButtonLink variant="ghost" size="sm" href="/admin/products" className="gap-1">
            <ArrowLeft className="w-4 h-4" /> Назад
          </ButtonLink>
          <h1 className="text-2xl font-bold">
            {mode === "create" ? "Нов продукт" : "Редакция"}
          </h1>
        </div>
        {mode === "edit" && loaded && (
          archived ? (
            <Button variant="outline" size="sm" className="gap-1.5" onClick={handleRestore}>
              <RotateCcw className="w-4 h-4" /> Възстанови
            </Button>
          ) : (
            <Button
              variant="destructive"
              size="sm"
              className="gap-1.5"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="w-4 h-4" /> Архивирай
            </Button>
          )
        )}
      </div>

      {archived && (
        <div role="status" className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Този продукт е архивиран. Възстановете го, за да се показва отново в каталога.
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Basic info */}
        <section className="rounded-lg border border-border bg-card p-5 space-y-4">
          <h2 className="font-semibold">Основна информация</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <Label htmlFor="name">Наименование *</Label>
              <Input id="name" value={form.name} onChange={(e) => setField("name", e.target.value)} required className="mt-1" />
            </div>
            <div>
              <Label htmlFor="code">SKU (продуктов код) *</Label>
              <Input id="code" value={form.code} onChange={(e) => setField("code", e.target.value)} required className="mt-1 font-mono text-sm" placeholder="EL-PH-003" />
            </div>
            <div>
              <Label htmlFor="price">Цена (EUR) *</Label>
              <Input id="price" inputMode="decimal" value={form.price} onChange={(e) => setField("price", e.target.value)} required className="mt-1" placeholder="0.00" />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="slug">URL идентификатор (slug)</Label>
              <Input
                id="slug"
                value={form.slug}
                onChange={(e) => setField("slug", e.target.value)}
                className="mt-1 font-mono text-xs"
                placeholder={form.name ? slugify(form.name) : "автоматично от името"}
              />
              <p className="text-xs text-muted-foreground mt-1">
                По желание — оставете празно, за да се генерира от името.
              </p>
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="description">Описание</Label>
              <Textarea id="description" value={form.description} onChange={(e) => setField("description", e.target.value)} rows={3} className="mt-1 resize-none" />
            </div>
          </div>
        </section>

        {/* Category */}
        <section className="rounded-lg border border-border bg-card p-5 space-y-4">
          <h2 className="font-semibold">Категория</h2>
          <div>
            <Label htmlFor="category">Категория</Label>
            <select
              id="category"
              value={form.categoryId}
              onChange={(e) => setField("categoryId", e.target.value)}
              className={selectClass}
            >
              <option value="">— Без категория —</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {"— ".repeat(c.depth)}
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </section>

        {/* Stock + NEW flag */}
        <section className="rounded-lg border border-border bg-card p-5 space-y-4">
          <h2 className="font-semibold">Наличност</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-center">
            <div>
              <Label htmlFor="stockStatus">Статус</Label>
              <select
                id="stockStatus"
                value={form.stockStatus}
                onChange={(e) => setField("stockStatus", e.target.value as FormState["stockStatus"])}
                className={selectClass}
              >
                <option value="in_stock">В наличност</option>
                <option value="out_of_stock">Изчерпано</option>
              </select>
            </div>
            <div className="flex items-center gap-2 sm:pt-6">
              <input
                type="checkbox"
                id="isNew"
                checked={form.isNew}
                onChange={(e) => setField("isNew", e.target.checked)}
                aria-label="Маркирай като НОВО за 30 дни"
                className="w-4 h-4 rounded border-input accent-primary"
              />
              <Label htmlFor="isNew">Маркирай като НОВО (30 дни)</Label>
            </div>
          </div>
        </section>

        {/* Images — the real upload pipeline */}
        <section className="rounded-lg border border-border bg-card p-5 space-y-3">
          <div>
            <h2 className="font-semibold">Снимки</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Първата снимка е основна. Подредете със стрелките.
            </p>
          </div>
          <ImageUploadField kind="products" value={images} onChange={setImages} idPrefix="prod" />
        </section>

        {formError && (
          <p role="alert" className="text-sm text-destructive">
            {formError}
          </p>
        )}

        <Separator />

        <div className="flex gap-3">
          <ButtonLink variant="outline" href="/admin/products">
            Откажи
          </ButtonLink>
          <Button type="submit" className="flex-1 gap-2" disabled={submitting || saved}>
            {saved ? (
              <>
                <Check className="w-4 h-4" /> Запазено!
              </>
            ) : submitting ? (
              "Запазване…"
            ) : mode === "create" ? (
              "Запази продукта"
            ) : (
              "Запази промените"
            )}
          </Button>
        </div>
      </form>

      {/* Archive confirmation */}
      <Dialog open={confirmDelete} onOpenChange={(open) => !open && setConfirmDelete(false)}>
        {confirmDelete && loaded && (
          <DeleteDialog
            product={loaded}
            onCancel={() => setConfirmDelete(false)}
            onSessionExpired={() => router.refresh()}
            onDone={() => {
              setConfirmDelete(false);
              router.push("/admin/products");
              router.refresh();
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

/** Compute the `newUntil` patch for an edit: re-light 30 days, clear, or no-op. */
function newUntilPatch(
  checked: boolean,
  wasNew: boolean,
): { newUntil?: string | null } {
  if (checked && !wasNew) return { newUntil: new Date(Date.now() + THIRTY_DAYS_MS).toISOString() };
  if (!checked && wasNew) return { newUntil: null };
  return {};
}

// ─── Archive confirmation dialog ──────────────────────────────────────────────

function DeleteDialog({
  product,
  onCancel,
  onSessionExpired,
  onDone,
}: {
  product: AdminProductDetail;
  onCancel: () => void;
  onSessionExpired: () => void;
  onDone: () => void;
}) {
  const [understood, setUnderstood] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasActiveOrders = product.activeOrderCount > 0;

  async function handleDelete() {
    setSubmitting(true);
    setError(null);
    const res = await deleteProduct(product.id, product.updatedAt);
    setSubmitting(false);
    if (res.ok) {
      onDone();
      return;
    }
    if (res.error.kind === "not_admin") {
      onSessionExpired();
      return;
    }
    setError(errorMessage(res.error));
  }

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Архивиране на „{product.name}“</DialogTitle>
        <DialogDescription>
          Продуктът се скрива от каталога и старият му URL започва да пренасочва
          (301) към категорията. Може да го възстановите по-късно.
        </DialogDescription>
      </DialogHeader>

      <div className="my-4 space-y-3 text-sm">
        {hasActiveOrders && (
          <div role="alert" className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
            <span>
              Този продукт участва в <strong>{product.activeOrderCount}</strong>{" "}
              активни поръчки. Историята на поръчките няма да бъде засегната
              (данните са запазени като snapshot).
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
        {error && <p role="alert" className="text-destructive">{error}</p>}
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
          Отказ
        </Button>
        <Button type="button" variant="destructive" onClick={handleDelete} disabled={!understood || submitting}>
          {submitting ? "Архивиране…" : "Архивирай"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
