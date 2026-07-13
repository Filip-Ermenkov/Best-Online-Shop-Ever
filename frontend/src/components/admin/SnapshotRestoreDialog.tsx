"use client";

/**
 * Snapshot restore — the destructive „възстановяване до избрана версия" of the
 * admin archive (docs/README.md §12; roadmap item 52). Replays a chosen catalog
 * backup over the LIVE catalog, so it follows the 2026 destructive-action
 * convention in full:
 *
 *   1. A modal (base-ui Dialog → focus trap + aria-modal + Escape), so the
 *      action is deliberate and can't be mis-clicked from the table.
 *   2. A dry-run PREVIEW fetched on open — the exact changes, above all which
 *      live rows created after the snapshot will be archived — so the admin sees
 *      the blast radius before committing.
 *   3. A typed „ВЪЗСТАНОВИ" confirmation (mirrors the account-deletion „ИЗТРИЙ"
 *      gate); the destructive button stays disabled until it matches, and the
 *      server re-checks it.
 *   4. The copy states that a pre-restore safety backup is taken automatically
 *      (the rollback point), so „необратимо" is honest but not frightening.
 *
 * The parent (ArchiveManager) owns the overview reload; this component reports
 * success via `onRestored(message)` and closes.
 */

import { useCallback, useEffect, useState } from "react";
import { RotateCcw, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { previewSnapshotRestore, restoreSnapshot } from "@/lib/admin/archive/client";
import type {
  AdminArchiveError,
  CatalogRestorePlan,
} from "@/lib/admin/archive/types";

/** The typed confirmation — must match the server's RESTORE_CONFIRMATION. */
const RESTORE_PHRASE = "ВЪЗСТАНОВИ";

function restoreErrorMessage(err: AdminArchiveError): string {
  switch (err.kind) {
    case "network":
      return "Връзката със сървъра пропадна. Опитайте отново.";
    case "not_admin":
      return "Сесията изтече. Презаредете страницата.";
    case "not_found":
      return "Този архив вече не е наличен. Обновете списъка.";
    case "snapshot_invalid":
      return "Този архив е повреден и не може да бъде възстановен.";
    case "restore_failed":
      return "Възстановяването не бе успешно (архивът не можа да бъде прочетен или предпазният архив се провали). Опитайте отново.";
    case "backups_unavailable":
      return "Възстановяването не е налично: не е конфигурирано хранилище за архиви.";
    case "restore_confirm":
      return "Потвърдителната дума е грешна.";
    default:
      return "detail" in err && err.detail
        ? err.detail
        : "Възникна неочаквана грешка.";
  }
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("bg-BG", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

interface SnapshotRestoreDialogProps {
  backup: { id: string; kind: "manual" | "scheduled"; createdAt: string };
  /** True when no backup bucket is configured — restore needs it to read the snapshot. */
  disabled: boolean;
  /** Called after a successful restore with a ready-to-show Bulgarian message. */
  onRestored: (message: string) => void;
  /** Called when the backup turns out to be gone (404) so the parent can reload. */
  onGone: () => void;
}

export default function SnapshotRestoreDialog({
  backup,
  disabled,
  onRestored,
  onGone,
}: SnapshotRestoreDialogProps) {
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<CatalogRestorePlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [restoring, setRestoring] = useState(false);

  // The "loading" state is derived: while the preview is in flight, both plan and
  // error are null (below). Keeping it derived avoids a synchronous setState in the
  // effect body (react-hooks/set-state-in-effect).
  const loading = plan === null && error === null;

  const reset = useCallback(() => {
    setPlan(null);
    setError(null);
    setConfirmText("");
    setRestoring(false);
  }, []);

  // Fetch the dry-run diff when the dialog opens. Every state update happens inside
  // the async callback (after the await), never synchronously in the effect body —
  // the same pattern as ArchiveManager's load effect.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const res = await previewSnapshotRestore(backup.id);
      if (cancelled) return;
      if (res.ok) {
        setPlan(res.value);
      } else {
        setError(restoreErrorMessage(res.error));
        if (res.error.kind === "not_found") onGone();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, backup.id, onGone]);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) reset();
  }

  async function handleRestore() {
    if (confirmText !== RESTORE_PHRASE) return;
    setRestoring(true);
    setError(null);
    const res = await restoreSnapshot(backup.id, confirmText);
    if (res.ok) {
      const { restored } = res.value;
      const archived =
        restored.willArchive.productCount + restored.willArchive.categoryCount;
      const suffix =
        archived > 0
          ? ` ${archived} по-нови записа бяха архивирани; предпазен архив е създаден.`
          : " Предпазен архив на предишното състояние е създаден.";
      onRestored(
        `Каталогът е възстановен към ${formatDateTime(restored.takenAt)}.${suffix}`,
      );
      handleOpenChange(false);
    } else {
      setRestoring(false);
      setError(restoreErrorMessage(res.error));
      if (res.error.kind === "not_found") onGone();
    }
  }

  const canRestore = confirmText === RESTORE_PHRASE && !restoring && plan !== null;
  const archiveCount = plan
    ? plan.willArchive.productCount + plan.willArchive.categoryCount
    : 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        disabled={disabled}
        aria-label={`Възстанови каталога от архива от ${formatDateTime(backup.createdAt)}`}
        onClick={() => setOpen(true)}
      >
        <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
        <span>Възстанови</span>
      </Button>

      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-red-600" aria-hidden="true" />
            Възстановяване от архив
          </DialogTitle>
          <DialogDescription>
            Каталогът ще бъде върнат към състоянието от{" "}
            <span className="font-medium text-foreground">
              {formatDateTime(backup.createdAt)}
            </span>
            . Преди възстановяването автоматично се създава предпазен архив на
            текущото състояние, така че действието е обратимо.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-16 w-full" />
          </div>
        )}

        {!loading && plan && (
          <div className="space-y-4 text-sm">
            <p className="text-muted-foreground">
              Архивът съдържа {plan.counts.categories} категории,{" "}
              {plan.counts.products} продукта, {plan.counts.productImages}{" "}
              изображения и {plan.counts.bannerSlides} банера.
            </p>

            {archiveCount > 0 ? (
              <div
                role="region"
                aria-label="Записи, които ще бъдат архивирани"
                className="rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-900"
              >
                <p className="font-medium">
                  {plan.willArchive.productCount} продукта и{" "}
                  {plan.willArchive.categoryCount} категории, създадени след този
                  архив, ще бъдат архивирани.
                </p>
                {plan.willArchive.productNames.length > 0 && (
                  <p className="mt-1 text-xs">
                    Продукти: {plan.willArchive.productNames.join(", ")}
                    {plan.willArchive.productCount >
                      plan.willArchive.productNames.length && " …"}
                  </p>
                )}
                {plan.willArchive.categoryNames.length > 0 && (
                  <p className="mt-1 text-xs">
                    Категории: {plan.willArchive.categoryNames.join(", ")}
                    {plan.willArchive.categoryCount >
                      plan.willArchive.categoryNames.length && " …"}
                  </p>
                )}
                <p className="mt-2 text-xs">
                  Те не се изтриват безвъзвратно — ще ги намерите в списъка с
                  архивирани записи и можете да ги възстановите поединично.
                </p>
              </div>
            ) : (
              <p className="text-muted-foreground">
                Няма по-нови записи — нищо няма да бъде архивирано.
              </p>
            )}

            <div>
              <Label htmlFor="restore-confirm">
                Напишете{" "}
                <span className="font-mono font-bold">{RESTORE_PHRASE}</span> за
                потвърждение
              </Label>
              <Input
                id="restore-confirm"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                autoComplete="off"
                autoCapitalize="characters"
                className="mt-1 font-mono"
                placeholder={RESTORE_PHRASE}
                disabled={restoring}
              />
            </div>
          </div>
        )}

        {error && (
          <p
            role="alert"
            aria-live="polite"
            className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md p-2"
          >
            {error}
          </p>
        )}

        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={restoring} />}>
            Отказ
          </DialogClose>
          <Button
            variant="destructive"
            disabled={!canRestore}
            onClick={handleRestore}
          >
            {restoring ? "Възстановяване…" : "Възстанови каталога"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
