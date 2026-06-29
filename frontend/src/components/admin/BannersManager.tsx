"use client";

/**
 * Admin banner management — the real /admin/banners screen
 * (docs/README.md §"Управление на банер"): a flat, ordered list of homepage
 * hero slides with create, edit, re-image, show/hide (without deleting),
 * accessible reorder, and delete-with-confirmation.
 *
 * The image goes through the real presigned-POST upload pipeline via the shared
 * `ImageUploadField` (kind="banners", max=1) — the same widget the product
 * editor uses, now proving its "build once, serve three kinds" promise.
 *
 * Data flows through the typed client in lib/admin/banners/. A flat 404 means
 * the admin session expired → router.refresh() re-renders the admin layout,
 * which swaps in the AdminAuthGate (same contract as CategoriesManager /
 * OrdersExplorer). Reordering uses accessible up/down buttons, not drag — WCAG
 * 2.2 SC 2.5.7 wants a single-pointer alternative to dragging anyway.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Eye,
  EyeOff,
  Image as ImageIcon,
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
import { sanitizeImageUrl } from "@/lib/utils";
import ImageUploadField, {
  type ImageDraft,
} from "@/components/admin/ImageUploadField";
import {
  createBanner,
  deleteBanner,
  fetchAdminBanners,
  reorderBanners,
  updateBanner,
} from "@/lib/admin/banners/client";
import type {
  AdminBannerSlide,
  AdminBannersError,
} from "@/lib/admin/banners/types";

// ─── Error copy ──────────────────────────────────────────────────────────────

function errorMessage(err: AdminBannersError): string {
  switch (err.kind) {
    case "version_conflict":
      return "Банерът е променен в друг раздел. Списъкът е презареден — опитайте отново.";
    case "reorder_mismatch":
      return "Подредбата е остаряла. Списъкът е презареден — опитайте отново.";
    case "validation":
      return err.fields[0]?.message ?? err.detail ?? "Невалидни данни.";
    case "banner_not_found":
      return "Банерът не е намерен.";
    case "network":
      return "Връзката със сървъра пропадна. Опитайте отново.";
    case "not_admin":
      return "Сесията изтече. Презаредете страницата.";
    default:
      return err.detail ?? "Възникна неочаквана грешка.";
  }
}

type DialogMode =
  | { type: "add" }
  | { type: "edit"; slide: AdminBannerSlide }
  | { type: "delete"; slide: AdminBannerSlide }
  | null;

// ─── Root component ──────────────────────────────────────────────────────────

export default function BannersManager() {
  const router = useRouter();
  const [banners, setBanners] = useState<AdminBannerSlide[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogMode>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetchAdminBanners();
      if (cancelled) return;
      if (res.ok) {
        setBanners(res.value.items);
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
    const res = await fetchAdminBanners();
    if (res.ok) {
      setBanners(res.value.items);
      setLoadError(null);
    } else if (res.error.kind === "not_admin") {
      router.refresh();
    } else {
      setLoadError(errorMessage(res.error));
    }
  }

  function sessionMaybeExpired(err: AdminBannersError): boolean {
    if (err.kind === "not_admin") {
      router.refresh();
      return true;
    }
    return false;
  }

  async function handleToggle(slide: AdminBannerSlide): Promise<void> {
    setBusyId(slide.id);
    setActionError(null);
    const res = await updateBanner(slide.id, {
      expectedUpdatedAt: slide.updatedAt,
      isActive: !slide.isActive,
    });
    setBusyId(null);
    if (res.ok) {
      setBanners((list) =>
        (list ?? []).map((b) => (b.id === slide.id ? res.value : b)),
      );
    } else if (!sessionMaybeExpired(res.error)) {
      setActionError(errorMessage(res.error));
      await reload();
    }
  }

  async function handleReorder(index: number, direction: -1 | 1): Promise<void> {
    const list = banners ?? [];
    const target = index + direction;
    if (target < 0 || target >= list.length) return;
    const ids = list.map((b) => b.id);
    const moved = ids[index]!;
    ids.splice(index, 1);
    ids.splice(target, 0, moved);
    setActionError(null);
    const res = await reorderBanners({ orderedIds: ids });
    if (res.ok) {
      setBanners(res.value.items);
    } else if (!sessionMaybeExpired(res.error)) {
      setActionError(errorMessage(res.error));
      await reload();
    }
  }

  const close = () => setDialog(null);

  return (
    <div>
      <div className="flex items-center justify-between mb-6 gap-3">
        <div>
          <h1 className="text-2xl font-bold">Банери</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Промоционални кадри на началната страница. Скритите кадри не се
            показват в магазина.
          </p>
        </div>
        <Button className="gap-2" onClick={() => setDialog({ type: "add" })}>
          <Plus className="w-4 h-4" />
          <span className="hidden sm:inline">Добави банер</span>
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
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          {loadError}
        </div>
      ) : banners === null ? (
        <div className="space-y-3" aria-hidden="true">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : banners.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-12 text-center">
          <ImageIcon className="w-8 h-8 mx-auto text-muted-foreground" aria-hidden="true" />
          <p className="mt-3 text-sm text-muted-foreground">
            Все още няма банери. Добавете първия с бутона горе.
          </p>
        </div>
      ) : (
        <ul className="space-y-3 list-none pl-0">
          {banners.map((slide, i) => (
            <li
              key={slide.id}
              className="rounded-lg border border-border bg-white p-4"
            >
              <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                <div className="w-full sm:w-32 h-32 sm:h-16 rounded bg-muted overflow-hidden flex-shrink-0">
                  {sanitizeImageUrl(slide.imageUrl) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={sanitizeImageUrl(slide.imageUrl)!}
                      alt={slide.title ?? "Банер"}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <ImageIcon className="w-5 h-5 text-muted-foreground" aria-hidden="true" />
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold">{slide.title ?? "(без заглавие)"}</p>
                  {slide.subtitle && (
                    <p className="text-sm text-muted-foreground">{slide.subtitle}</p>
                  )}
                  {slide.linkUrl && (
                    <p className="text-xs text-primary-strong truncate font-mono">
                      {slide.linkUrl}
                    </p>
                  )}
                  <span
                    className={
                      "mt-1 inline-block rounded-full px-2 py-0.5 text-xs " +
                      (slide.isActive
                        ? "bg-green-50 text-green-700 border border-green-200"
                        : "bg-muted text-muted-foreground border border-border")
                    }
                  >
                    {slide.isActive ? "Активен" : "Скрит"}
                  </span>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => handleReorder(i, -1)}
                    disabled={i === 0}
                    className="p-1.5 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
                    aria-label="Премести нагоре"
                  >
                    <ArrowUp className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleReorder(i, 1)}
                    disabled={i === banners.length - 1}
                    className="p-1.5 rounded hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
                    aria-label="Премести надолу"
                  >
                    <ArrowDown className="w-3.5 h-3.5" />
                  </button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 px-2 sm:px-3 gap-1.5"
                    onClick={() => handleToggle(slide)}
                    disabled={busyId === slide.id}
                    aria-label={slide.isActive ? "Скрий банера" : "Покажи банера"}
                  >
                    {slide.isActive ? (
                      <>
                        <EyeOff className="w-3.5 h-3.5" />
                        <span className="hidden md:inline text-xs">Скрий</span>
                      </>
                    ) : (
                      <>
                        <Eye className="w-3.5 h-3.5" />
                        <span className="hidden md:inline text-xs">Покажи</span>
                      </>
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2 sm:px-3 gap-1"
                    onClick={() => setDialog({ type: "edit", slide })}
                    aria-label="Редактирай"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                    <span className="hidden md:inline text-xs">Редактирай</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2 text-destructive hover:text-destructive hover:bg-destructive/10"
                    onClick={() => setDialog({ type: "delete", slide })}
                    aria-label="Изтрий"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Create / edit dialog */}
      <Dialog
        open={dialog?.type === "add" || dialog?.type === "edit"}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        {(dialog?.type === "add" || dialog?.type === "edit") && (
          <BannerFormDialog
            slide={dialog.type === "edit" ? dialog.slide : null}
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
            slide={dialog.slide}
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

// ─── Create / edit form ──────────────────────────────────────────────────────

function BannerFormDialog({
  slide,
  onSuccess,
  onSessionExpired,
  onCancel,
}: {
  slide: AdminBannerSlide | null;
  onSuccess: () => void | Promise<void>;
  onSessionExpired: () => void;
  onCancel: () => void;
}) {
  const isEdit = slide !== null;
  const [images, setImages] = useState<ImageDraft[]>(
    slide
      ? [
          {
            s3Key: slide.imageS3Key,
            altText: "",
            previewUrl: sanitizeImageUrl(slide.imageUrl),
          },
        ]
      : [],
  );
  const [title, setTitle] = useState(slide?.title ?? "");
  const [subtitle, setSubtitle] = useState(slide?.subtitle ?? "");
  const [linkUrl, setLinkUrl] = useState(slide?.linkUrl ?? "");
  const [isActive, setIsActive] = useState(slide?.isActive ?? true);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const imageKey = images[0]?.s3Key ?? "";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!imageKey) {
      setFormError("Изображението е задължително.");
      return;
    }
    setSubmitting(true);
    setFormError(null);

    const result = isEdit
      ? await updateBanner(slide!.id, {
          expectedUpdatedAt: slide!.updatedAt,
          imageS3Key: imageKey,
          title: title.trim() || null,
          subtitle: subtitle.trim() || null,
          linkUrl: linkUrl.trim() || null,
          isActive,
        })
      : await createBanner({
          imageS3Key: imageKey,
          title: title.trim() || null,
          subtitle: subtitle.trim() || null,
          linkUrl: linkUrl.trim() || null,
          isActive,
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
    <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
      <form onSubmit={handleSubmit}>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Редактиране на банер" : "Нов банер"}</DialogTitle>
          <DialogDescription>
            Хоризонтално изображение с по желание заглавие, описание и вътрешен
            линк. Скритите банери не се показват в магазина.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 my-4">
          <div>
            <p className="text-sm font-medium mb-1.5">Изображение *</p>
            <ImageUploadField
              kind="banners"
              value={images}
              onChange={setImages}
              max={1}
              idPrefix="banner-img"
            />
          </div>
          <div>
            <Label htmlFor="banner-title">Заглавен текст</Label>
            <Input
              id="banner-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Напр. Пролетни намаления"
              className="mt-1"
              maxLength={120}
            />
          </div>
          <div>
            <Label htmlFor="banner-subtitle">Описателен текст</Label>
            <Input
              id="banner-subtitle"
              value={subtitle}
              onChange={(e) => setSubtitle(e.target.value)}
              placeholder="Напр. До -30% на избрани продукти"
              className="mt-1"
              maxLength={240}
            />
          </div>
          <div>
            <Label htmlFor="banner-link">Линк (по желание)</Label>
            <Input
              id="banner-link"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              placeholder="/products/elektronika"
              className="mt-1 font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Вътрешен адрес към категория или продукт, започващ с „/“.
            </p>
          </div>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              aria-label="Активен (показва се в магазина)"
              className="h-4 w-4 rounded border-input accent-primary"
            />
            <span aria-hidden="true" className="text-sm">
              Активен (показва се в магазина)
            </span>
          </label>
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
          <Button type="submit" disabled={submitting || !imageKey}>
            {submitting ? "Запазване…" : "Запази"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

// ─── Delete confirmation ─────────────────────────────────────────────────────

function DeleteDialog({
  slide,
  onSuccess,
  onSessionExpired,
  onCancel,
}: {
  slide: AdminBannerSlide;
  onSuccess: () => void | Promise<void>;
  onSessionExpired: () => void;
  onCancel: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleDelete() {
    setSubmitting(true);
    setDeleteError(null);
    const res = await deleteBanner(slide.id, slide.updatedAt);
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

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Изтриване на банер</DialogTitle>
        <DialogDescription>
          Този кадър ще бъде премахнат окончателно. За временно скриване
          използвайте „Скрий“ вместо изтриване.
        </DialogDescription>
      </DialogHeader>

      {deleteError && (
        <p role="alert" className="text-sm text-destructive my-2">
          {deleteError}
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
          Отказ
        </Button>
        <Button
          type="button"
          variant="destructive"
          onClick={handleDelete}
          disabled={submitting}
        >
          {submitting ? "Изтриване…" : "Изтрий"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
