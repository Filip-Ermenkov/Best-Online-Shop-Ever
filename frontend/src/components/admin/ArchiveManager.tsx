"use client";

/**
 * Admin archive — the recovery screen (docs/README.md §12 „Архивиране и
 * възстановяване"). The LAST admin page that rendered mock data; this component
 * (roadmap item 51) replaces the mock with the real `/admin/archive` API via the
 * typed client in lib/admin/archive/.
 *
 * Three things, matching 2026 "trash + backups" practice: a list of soft-deleted
 * products and one of soft-deleted categories — each with an explicit per-item
 * restore — and the list of point-in-time catalog snapshots the scheduler writes,
 * with a one-button on-demand („Ръчно") backup. Each snapshot also offers a full
 * „Възстанови" — replaying it over the live catalog behind a preview + typed
 * confirmation + an automatic pre-restore safety backup (roadmap item 52, in the
 * SnapshotRestoreDialog child), so the high-blast-radius restore is deliberate
 * and reversible.
 *
 * A flat 404 on the overview means the admin session expired → router.refresh()
 * re-renders the admin layout's AdminAuthGate (same contract as the other
 * managers). Action feedback is announced in an aria-live region.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, RefreshCw, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/utils";
import SnapshotRestoreDialog from "@/components/admin/SnapshotRestoreDialog";
import {
  fetchAdminArchive,
  restoreArchivedCategory,
  restoreArchivedProduct,
  triggerManualBackup,
} from "@/lib/admin/archive/client";
import type { AdminArchiveError, ArchiveOverview } from "@/lib/admin/archive/types";

type Feedback = { tone: "success" | "error"; text: string };

function errorMessage(err: AdminArchiveError): string {
  switch (err.kind) {
    case "network":
      return "Връзката със сървъра пропадна. Опитайте отново.";
    case "not_admin":
      return "Сесията изтече. Презаредете страницата.";
    case "conflict":
      return (
        err.detail ??
        "Активна категория вече използва това URL име. Преименувайте я, преди да възстановите."
      );
    case "backups_unavailable":
      return "Ръчното архивиране не е налично: не е конфигурирано хранилище за архиви.";
    case "backup_failed":
      return "Архивирането не бе успешно. Проверете хранилището и опитайте отново.";
    case "not_found":
      return "Записът вече е възстановен.";
    case "snapshot_invalid":
      return "Този архив е повреден и не може да бъде възстановен.";
    case "restore_failed":
      return "Възстановяването не бе успешно. Опитайте отново.";
    default:
      return "detail" in err && err.detail
        ? err.detail
        : "Възникна неочаквана грешка.";
  }
}

function formatBytes(n: number | null): string {
  if (n === null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ArchiveManager() {
  const router = useRouter();
  const [data, setData] = useState<ArchiveOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [backingUp, setBackingUp] = useState(false);

  const apply = useCallback(
    (res: Awaited<ReturnType<typeof fetchAdminArchive>>) => {
      if (res.ok) {
        setData(res.value);
        setLoadError(null);
      } else if (res.error.kind === "not_admin") {
        router.refresh();
      } else {
        setLoadError(errorMessage(res.error));
      }
    },
    [router],
  );

  const load = useCallback(async () => {
    setRefreshing(true);
    const res = await fetchAdminArchive();
    setRefreshing(false);
    apply(res);
  }, [apply]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetchAdminArchive();
      if (cancelled) return;
      apply(res);
    })();
    return () => {
      cancelled = true;
    };
  }, [apply]);

  async function handleRestoreProduct(id: string, name: string) {
    setPendingId(id);
    setFeedback(null);
    const res = await restoreArchivedProduct(id);
    setPendingId(null);
    if (res.ok) {
      setFeedback({ tone: "success", text: `„${name}" е възстановен.` });
      await load();
    } else if (res.error.kind === "not_found") {
      setFeedback({ tone: "success", text: `„${name}" вече е възстановен.` });
      await load();
    } else {
      setFeedback({ tone: "error", text: errorMessage(res.error) });
    }
  }

  async function handleRestoreCategory(id: string, name: string) {
    setPendingId(id);
    setFeedback(null);
    const res = await restoreArchivedCategory(id);
    setPendingId(null);
    if (res.ok) {
      setFeedback({ tone: "success", text: `Категория „${name}" е възстановена.` });
      await load();
    } else if (res.error.kind === "not_found") {
      setFeedback({ tone: "success", text: `Категория „${name}" вече е възстановена.` });
      await load();
    } else if (res.error.kind === "not_admin") {
      router.refresh();
    } else {
      setFeedback({ tone: "error", text: errorMessage(res.error) });
    }
  }

  async function handleManualBackup() {
    setBackingUp(true);
    setFeedback(null);
    const res = await triggerManualBackup();
    setBackingUp(false);
    if (res.ok) {
      setFeedback({ tone: "success", text: "Създаден е нов архив на каталога." });
      await load();
    } else if (res.error.kind === "not_admin") {
      router.refresh();
    } else {
      setFeedback({ tone: "error", text: errorMessage(res.error) });
    }
  }

  // A full snapshot restore succeeded (the SnapshotRestoreDialog owns the
  // preview + typed-confirm flow); surface its message and reload the overview —
  // the restore also wrote a fresh pre-restore safety backup that now appears.
  const handleRestored = useCallback(
    (message: string) => {
      setFeedback({ tone: "success", text: message });
      void load();
    },
    [load],
  );

  if (loadError) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-6">Архив</h1>
        <p role="alert" className="text-sm text-red-700">
          {loadError}
        </p>
        <button
          type="button"
          onClick={load}
          className="mt-4 inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted/50"
        >
          <RefreshCw className="w-4 h-4" aria-hidden="true" /> Опитай отново
        </button>
      </div>
    );
  }

  if (!data) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-6">Архив</h1>
        <Skeleton className="h-10 w-64 mb-6" />
        <Skeleton className="h-40 w-full mb-8" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const { archivedProducts, archivedCategories, backups, backupsAvailable } = data;

  return (
    <div>
      <div className="flex items-center justify-between mb-6 gap-4">
        <h1 className="text-2xl font-bold">Архив</h1>
        <button
          type="button"
          onClick={load}
          disabled={refreshing}
          className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted/50 disabled:opacity-60"
        >
          <RefreshCw
            className={`w-4 h-4${refreshing ? " animate-spin" : ""}`}
            aria-hidden="true"
          />
          <span>{refreshing ? "Обновяване…" : "Обнови"}</span>
        </button>
      </div>

      {/* Action feedback — announced to assistive tech. */}
      <p
        aria-live="polite"
        role="status"
        className={`text-sm mb-4 min-h-[1.25rem] ${
          feedback?.tone === "error" ? "text-red-700" : "text-green-700"
        }`}
      >
        {feedback?.text ?? ""}
      </p>

      {/* Soft-deleted products + categories, each with per-item restore. */}
      <Tabs defaultValue="products">
        <TabsList className="mb-6">
          <TabsTrigger value="products">Продукти ({archivedProducts.length})</TabsTrigger>
          <TabsTrigger value="categories">Категории ({archivedCategories.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="products">
          {archivedProducts.length === 0 ? (
            <p className="text-muted-foreground text-sm py-10 text-center">
              Няма архивирани продукти.
            </p>
          ) : (
            <div className="rounded-lg border border-border bg-white overflow-x-auto">
              <table className="w-full text-sm min-w-[560px]">
                <thead className="bg-muted/50 border-b border-border">
                  <tr>
                    <th scope="col" className="text-left px-4 py-3 font-medium">Продукт</th>
                    <th scope="col" className="text-left px-4 py-3 font-medium">Код</th>
                    <th scope="col" className="text-left px-4 py-3 font-medium">Категория</th>
                    <th scope="col" className="text-left px-4 py-3 font-medium">Архивиран</th>
                    <th scope="col" className="px-4 py-3">
                      <span className="sr-only">Действия</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {archivedProducts.map((p) => (
                    <tr key={p.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-3 font-medium">{p.name}</td>
                      <td className="px-4 py-3 text-muted-foreground font-mono text-xs">{p.code}</td>
                      <td className="px-4 py-3 text-muted-foreground">{p.categoryName ?? "—"}</td>
                      <td className="px-4 py-3 text-muted-foreground">{formatDate(p.deletedAt)}</td>
                      <td className="px-4 py-3 text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1.5"
                          disabled={pendingId === p.id}
                          aria-label={`Възстанови продукт ${p.name}`}
                          onClick={() => handleRestoreProduct(p.id, p.name)}
                        >
                          <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>{pendingId === p.id ? "Възстановяване…" : "Възстанови"}</span>
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="categories">
          {archivedCategories.length === 0 ? (
            <p className="text-muted-foreground text-sm py-10 text-center">
              Няма архивирани категории.
            </p>
          ) : (
            <ul className="space-y-2">
              {archivedCategories.map((c) => (
                <li
                  key={c.id}
                  className="flex items-center justify-between gap-4 rounded-lg border border-border bg-white px-4 py-3"
                >
                  <span className="flex flex-col">
                    <span className="font-medium">{c.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {c.parentName ? `в „${c.parentName}"` : "основна категория"} · архивирана{" "}
                      {formatDate(c.deletedAt)}
                    </span>
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 flex-shrink-0"
                    disabled={pendingId === c.id}
                    aria-label={`Възстанови категория ${c.name}`}
                    onClick={() => handleRestoreCategory(c.id, c.name)}
                  >
                    <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>{pendingId === c.id ? "Възстановяване…" : "Възстанови"}</span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>
      </Tabs>

      {/* Point-in-time catalog snapshots + on-demand backup. */}
      <section className="mt-10" aria-labelledby="backups-heading">
        <div className="flex items-center justify-between mb-3 gap-4">
          <h2 id="backups-heading" className="font-semibold">
            Архивни версии на каталога
          </h2>
          <Button
            size="sm"
            className="gap-1.5"
            disabled={!backupsAvailable || backingUp}
            onClick={handleManualBackup}
          >
            <Download className="w-4 h-4" aria-hidden="true" />
            <span>{backingUp ? "Архивиране…" : "Направи архив сега"}</span>
          </Button>
        </div>

        {!backupsAvailable && (
          <p className="text-xs text-muted-foreground mb-3">
            Ръчното архивиране е налично само когато е конфигурирано хранилище за архиви.
            Автоматичните дневни архиви продължават да се създават от системата.
          </p>
        )}

        {backups.length === 0 ? (
          <p className="text-muted-foreground text-sm py-8 text-center rounded-lg border border-border bg-white">
            Още няма архивни версии.
          </p>
        ) : (
          <div className="rounded-lg border border-border bg-white overflow-x-auto">
            <table className="w-full text-sm min-w-[560px]">
              <thead className="bg-muted/50 border-b border-border">
                <tr>
                  <th scope="col" className="text-left px-4 py-3 font-medium">Дата и час</th>
                  <th scope="col" className="text-left px-4 py-3 font-medium">Вид</th>
                  <th scope="col" className="text-right px-4 py-3 font-medium">Размер</th>
                  <th scope="col" className="px-4 py-3">
                    <span className="sr-only">Действия</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {backups.map((b) => (
                  <tr key={b.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-3">
                      {new Date(b.createdAt).toLocaleString("bg-BG", {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-muted">
                        {b.kind === "manual" ? "Ръчен" : "Автоматичен"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-muted-foreground">
                      {formatBytes(b.sizeBytes)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <SnapshotRestoreDialog
                        backup={b}
                        disabled={!backupsAvailable}
                        onRestored={handleRestored}
                        onGone={load}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {backups.length > 0 && (
          <p className="text-xs text-muted-foreground mt-2">
            „Възстанови“ връща целия каталог към избрания архив. По-новите записи
            се архивират (обратимо), а автоматично се създава предпазен архив на
            текущото състояние преди възстановяването.
          </p>
        )}
      </section>
    </div>
  );
}
