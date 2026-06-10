"use client";

/**
 * Admin orders list — the real /admin/orders screen (spec §"Управление на
 * поръчки"): search, filters, offset pagination (25/page, controls top AND
 * bottom per spec), CSV export honouring the active filters, and the red
 * expired-pickup-deadline marking.
 *
 * Data flows through the typed client in lib/admin/orders/. A flat 404 from
 * the admin surface means the session expired — `router.refresh()` re-renders
 * the admin layout, which swaps in the AdminAuthGate.
 *
 * Data loading follows the repo's proven client pattern (see
 * app/(shop)/account/orders/page.tsx): an inline async IIFE inside the
 * effect with a `cancelled` flag — every setState happens after an await,
 * which `react-hooks/set-state-in-effect` accepts, and the cleanup flag
 * makes superseded responses no-ops. The "current time" used for the
 * expired-deadline mark is captured ONCE per load (`now` state) so render
 * stays pure (`react-hooks/purity` forbids Date.now() during render).
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ChevronRight, Download, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCents } from "@/lib/utils";
import {
  downloadAdminOrdersCsv,
  fetchAdminOrders,
} from "@/lib/admin/orders/client";
import type {
  AdminOrdersFilters,
  AdminOrdersPage,
  OrderStatus,
} from "@/lib/admin/orders/types";

export const ORDER_STATUS_CONFIG: Record<
  OrderStatus,
  { label: string; className: string }
> = {
  processing:       { label: "Обработва се",      className: "bg-amber-100 text-amber-700 border-amber-200" },
  shipped:          { label: "Изпратена",          className: "bg-blue-100 text-blue-700 border-blue-200" },
  ready_for_pickup: { label: "Готова за вземане",  className: "bg-blue-100 text-blue-700 border-blue-200" },
  delivered:        { label: "Доставена",          className: "bg-green-100 text-green-700 border-green-200" },
  accepted:         { label: "Приета",             className: "bg-green-100 text-green-700 border-green-200" },
  returned:         { label: "Върната",            className: "bg-red-100 text-red-700 border-red-200" },
  cancelled:        { label: "Отказана",           className: "bg-red-100 text-red-700 border-red-200" },
};

export const PAYMENT_LABELS: Record<"cash_on_delivery" | "pay_at_store", string> = {
  cash_on_delivery: "Наложен платеж",
  pay_at_store: "Плащане на място",
};

const CUSTOMER_TYPE_LABELS = {
  guest: "Гост",
  personal: "Физическо лице",
  corporate: "Фирма",
} as const;

function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat("bg-BG", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Europe/Sofia",
  }).format(new Date(iso));
}

/**
 * `now` is captured at data-load time (not Date.now() in render — render
 * must stay pure). `now === 0` means "no data loaded yet" → never expired.
 */
function isPickupExpired(
  o: { status: OrderStatus; pickupDeadline: string | null },
  now: number,
): boolean {
  return (
    now > 0 &&
    o.status === "ready_for_pickup" &&
    !!o.pickupDeadline &&
    new Date(o.pickupDeadline).getTime() < now
  );
}

const selectClass =
  "h-9 text-sm border border-input rounded-md px-2 bg-background focus:outline-none focus:ring-2 focus:ring-ring";

type FilterState = Omit<AdminOrdersFilters, "page" | "pageSize">;

export default function OrdersExplorer() {
  const router = useRouter();
  const [filters, setFilters] = useState<FilterState>({});
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AdminOrdersPage | null>(null);
  const [now, setNow] = useState(0); // wall-clock captured per load
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  // The search box is "apply on submit" (Enter / button); everything else
  // applies instantly. Keeps typing from spamming the API without a debounce.
  const [searchDraft, setSearchDraft] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetchAdminOrders({ ...filters, page, pageSize: 25 });
      if (cancelled) return;
      if (res.ok) {
        setNow(Date.now());
        setData(res.value);
        setError(null);
        return;
      }
      if (res.error.kind === "not_admin") {
        router.refresh(); // session expired → admin layout shows the gate
        return;
      }
      setError(
        res.error.kind === "network"
          ? "Не може да се свърже със сървъра. Проверете интернет връзката."
          : "Възникна неочаквана грешка при зареждането на поръчките.",
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [filters, page, router]);

  function applyFilter<K extends keyof FilterState>(key: K, value: FilterState[K]) {
    setPage(1);
    setFilters((f) => ({ ...f, [key]: value || undefined }));
  }

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    applyFilter("q", searchDraft.trim() || undefined);
  }

  function clearFilters() {
    setSearchDraft("");
    setPage(1);
    setFilters({});
  }

  async function exportCsv() {
    setExporting(true);
    const res = await downloadAdminOrdersCsv(filters);
    setExporting(false);
    if (!res.ok) {
      if (res.error.kind === "not_admin") {
        router.refresh();
        return;
      }
      setError("Експортът не успя. Опитайте отново.");
    }
  }

  const hasActiveFilters =
    Object.values(filters).some((v) => v !== undefined) || searchDraft !== "";

  const pagination =
    data && data.totalPages > 1 ? (
      <nav
        aria-label="Страници с поръчки"
        className="flex items-center justify-between gap-3 text-sm"
      >
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => setPage((p) => Math.max(1, p - 1))}
        >
          ← Назад
        </Button>
        <span className="text-muted-foreground">
          Страница {data.page} от {data.totalPages}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= data.totalPages}
          onClick={() => setPage((p) => p + 1)}
        >
          Напред →
        </Button>
      </nav>
    ) : null;

  return (
    <div>
      <div className="flex items-center justify-between mb-6 gap-3">
        <div>
          <h1 className="text-2xl font-bold">Поръчки</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {data ? `${data.total} поръчки` : "Зареждане…"}
          </p>
        </div>
        <Button
          variant="outline"
          className="gap-2"
          onClick={exportCsv}
          disabled={exporting || !data || data.total === 0}
        >
          <Download className="w-4 h-4" aria-hidden="true" />
          <span className="hidden sm:inline">
            {exporting ? "Експортиране…" : "Експорт CSV"}
          </span>
          <span className="sr-only sm:hidden">Експорт CSV</span>
        </Button>
      </div>

      {/* Filters */}
      <div className="rounded-lg border border-border bg-card p-3 mb-4 space-y-3">
        <form onSubmit={submitSearch} className="flex gap-2" role="search">
          <Input
            type="search"
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            placeholder="Номер, имейл, телефон или фирма…"
            aria-label="Търсене по номер на поръчка, имейл, телефон или фирма"
            className="max-w-md"
          />
          <Button type="submit" variant="secondary" className="gap-1.5">
            <Search className="w-4 h-4" aria-hidden="true" />
            Търси
          </Button>
        </form>
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <label className="grid gap-1">
            <span className="text-xs text-muted-foreground">Статус</span>
            <select
              aria-label="Филтър по статус"
              className={selectClass}
              value={filters.status ?? ""}
              onChange={(e) =>
                applyFilter("status", (e.target.value || undefined) as OrderStatus | undefined)
              }
            >
              <option value="">Всички</option>
              {Object.entries(ORDER_STATUS_CONFIG).map(([value, cfg]) => (
                <option key={value} value={value}>
                  {cfg.label}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1">
            <span className="text-xs text-muted-foreground">Плащане</span>
            <select
              aria-label="Филтър по начин на плащане"
              className={selectClass}
              value={filters.paymentMethod ?? ""}
              onChange={(e) =>
                applyFilter(
                  "paymentMethod",
                  (e.target.value || undefined) as FilterState["paymentMethod"],
                )
              }
            >
              <option value="">Всички</option>
              <option value="cash_on_delivery">Наложен платеж</option>
              <option value="pay_at_store">Плащане на място</option>
            </select>
          </label>
          <label className="grid gap-1">
            <span className="text-xs text-muted-foreground">Тип клиент</span>
            <select
              aria-label="Филтър по тип клиент"
              className={selectClass}
              value={filters.customerType ?? ""}
              onChange={(e) =>
                applyFilter(
                  "customerType",
                  (e.target.value || undefined) as FilterState["customerType"],
                )
              }
            >
              <option value="">Всички</option>
              <option value="guest">Гост</option>
              <option value="personal">Физическо лице</option>
              <option value="corporate">Фирма</option>
            </select>
          </label>
          {/* htmlFor + id: the a11y rule can't see through the <Input>
              design-system wrapper, so the association is made explicit. */}
          <label className="grid gap-1" htmlFor="orders-filter-from">
            <span className="text-xs text-muted-foreground">От дата</span>
            <Input
              id="orders-filter-from"
              type="date"
              className="h-9 w-auto"
              value={filters.from ?? ""}
              onChange={(e) => applyFilter("from", e.target.value || undefined)}
            />
          </label>
          <label className="grid gap-1" htmlFor="orders-filter-to">
            <span className="text-xs text-muted-foreground">До дата</span>
            <Input
              id="orders-filter-to"
              type="date"
              className="h-9 w-auto"
              value={filters.to ?? ""}
              onChange={(e) => applyFilter("to", e.target.value || undefined)}
            />
          </label>
          {hasActiveFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              Изчисти филтрите
            </Button>
          )}
        </div>
      </div>

      {error && (
        <p
          role="alert"
          aria-live="polite"
          className="mb-4 text-sm text-destructive bg-destructive/5 border border-destructive/20 rounded-md p-3"
        >
          {error}
        </p>
      )}

      {pagination && <div className="mb-3">{pagination}</div>}

      {data === null ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      ) : data.items.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          Няма поръчки, отговарящи на избраните филтри.
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="rounded-lg border border-border bg-card overflow-hidden hidden md:block">
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[720px]">
                <thead className="bg-muted/50 border-b border-border">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium">Номер</th>
                    <th className="text-left px-4 py-3 font-medium">Дата</th>
                    <th className="text-left px-4 py-3 font-medium">Клиент</th>
                    <th className="text-left px-4 py-3 font-medium">Плащане</th>
                    <th className="text-left px-4 py-3 font-medium">Статус</th>
                    <th className="text-right px-4 py-3 font-medium">Сума</th>
                    <th className="px-4 py-3">
                      <span className="sr-only">Действия</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((o) => {
                    const cfg = ORDER_STATUS_CONFIG[o.status];
                    const expired = isPickupExpired(o, now);
                    return (
                      <tr
                        key={o.id}
                        className={`border-b border-border last:border-0 transition-colors ${
                          expired ? "bg-red-50 hover:bg-red-100/60" : "hover:bg-muted/20"
                        }`}
                      >
                        <td className="px-4 py-3 font-medium whitespace-nowrap">
                          {o.orderNumber}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                          {formatDateTime(o.createdAt)}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          <span className="block truncate max-w-[220px]">
                            {o.companyName ?? o.customerName}
                          </span>
                          <span className="block text-xs truncate max-w-[220px]">
                            {o.customerEmail} · {CUSTOMER_TYPE_LABELS[o.customerType]}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                          {PAYMENT_LABELS[o.paymentMethod]}
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant="outline" className={cfg.className}>
                            {cfg.label}
                          </Badge>
                          {expired && (
                            <span className="mt-1 flex items-center gap-1 text-xs font-medium text-red-700">
                              <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
                              Изтекъл срок за вземане
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right font-semibold whitespace-nowrap">
                          {formatCents(o.totalCents)}
                        </td>
                        <td className="px-4 py-3">
                          <ButtonLink
                            variant="ghost"
                            size="sm"
                            href={`/admin/orders/${encodeURIComponent(o.orderNumber)}`}
                          >
                            Виж
                          </ButtonLink>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile card list */}
          <div className="md:hidden space-y-3">
            {data.items.map((o) => {
              const cfg = ORDER_STATUS_CONFIG[o.status];
              const expired = isPickupExpired(o, now);
              return (
                <Link
                  key={o.id}
                  href={`/admin/orders/${encodeURIComponent(o.orderNumber)}`}
                  className={`block rounded-lg border p-4 space-y-2 transition-colors ${
                    expired
                      ? "border-red-300 bg-red-50 hover:bg-red-100/60"
                      : "border-border bg-white hover:bg-muted/20"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-sm">{o.orderNumber}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {o.companyName ?? o.customerName} · {o.customerEmail}
                      </p>
                    </div>
                    <Badge variant="outline" className={`${cfg.className} flex-shrink-0`}>
                      {cfg.label}
                    </Badge>
                  </div>
                  {expired && (
                    <p className="flex items-center gap-1 text-xs font-medium text-red-700">
                      <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
                      Изтекъл срок за вземане
                    </p>
                  )}
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-xs text-muted-foreground">
                      {formatDateTime(o.createdAt)} · {PAYMENT_LABELS[o.paymentMethod]}
                    </span>
                    <span className="font-semibold">{formatCents(o.totalCents)}</span>
                  </div>
                  <div className="flex items-center justify-end text-xs text-primary-strong pt-1 border-t border-border">
                    Виж детайли <ChevronRight className="w-3 h-3 ml-0.5" aria-hidden="true" />
                  </div>
                </Link>
              );
            })}
          </div>
        </>
      )}

      {pagination && <div className="mt-3">{pagination}</div>}
    </div>
  );
}
