"use client";

/**
 * Admin account management — the real /admin/customers screen (spec §"Управление
 * на акаунти" + §11 „Отстъпки"). Un-mocks the page: a searchable, filterable,
 * offset-paginated customer list (25/page) and a detail view that sets/clears the
 * per-account percentage discount, shows the order history, and deletes the
 * account (blocked while orders are in flight — spec §10).
 *
 * Data flows through the typed client in lib/admin/customers/. A flat 404 from
 * the admin surface (no specific problem type) means the session expired →
 * `router.refresh()` re-renders the admin layout, which swaps in the
 * AdminAuthGate — the same contract as the other admin managers.
 *
 * Master/detail without unmounting the list: the list stays mounted (its filter
 * and page state persist) behind `hidden` while the detail is open; a
 * `refreshKey` bump makes it refetch after a discount change or a deletion so its
 * columns never go stale.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  Search,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCents, formatDate } from "@/lib/utils";
import {
  clearCustomerDiscount,
  deleteAdminCustomer,
  fetchAdminCustomer,
  fetchAdminCustomers,
  setCustomerDiscount,
} from "@/lib/admin/customers/client";
import type {
  AdminCustomerDetail,
  AdminCustomerList,
  AdminCustomersError,
  CustomerListFilters,
} from "@/lib/admin/customers/types";

const ORDER_STATUS_LABELS: Record<string, string> = {
  processing: "Обработва се",
  shipped: "Изпратена",
  ready_for_pickup: "Готова за вземане",
  delivered: "Доставена",
  accepted: "Приета",
  returned: "Върната",
  cancelled: "Отказана",
};

const selectClass =
  "h-9 text-sm border border-input rounded-md px-2 bg-background focus:outline-none focus:ring-2 focus:ring-ring";

function errorMessage(e: AdminCustomersError): string {
  switch (e.kind) {
    case "network":
      return "Не може да се свърже със сървъра. Проверете интернет връзката.";
    case "not_found":
      return "Клиентът не е намерен.";
    case "version_conflict":
      return "Отстъпката е променена в друг раздел. Данните бяха презаредени — опитайте отново.";
    case "validation":
      return e.fields[0]?.message ?? e.detail ?? "Невалидни данни.";
    default:
      return "Възникна неочаквана грешка.";
  }
}

export default function CustomersManager() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <>
      <div hidden={selectedId !== null}>
        <CustomerListView refreshKey={refreshKey} onSelect={setSelectedId} />
      </div>
      {selectedId && (
        <CustomerDetailView
          id={selectedId}
          onBack={() => setSelectedId(null)}
          onChanged={() => setRefreshKey((k) => k + 1)}
          onDeleted={() => {
            setSelectedId(null);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
    </>
  );
}

// ─── List ──────────────────────────────────────────────────────────────────

type FilterState = Omit<CustomerListFilters, "page">;

function CustomerListView({
  refreshKey,
  onSelect,
}: {
  refreshKey: number;
  onSelect: (id: string) => void;
}) {
  const router = useRouter();
  const [filters, setFilters] = useState<FilterState>({});
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AdminCustomerList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchDraft, setSearchDraft] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetchAdminCustomers({ ...filters, page });
      if (cancelled) return;
      if (res.ok) {
        setData(res.value);
        setError(null);
        return;
      }
      if (res.error.kind === "not_admin") {
        router.refresh();
        return;
      }
      setError(errorMessage(res.error));
    })();
    return () => {
      cancelled = true;
    };
  }, [filters, page, refreshKey, router]);

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

  const hasActiveFilters =
    Object.values(filters).some((v) => v !== undefined) || searchDraft !== "";

  const pagination =
    data && data.totalPages > 1 ? (
      <nav
        aria-label="Страници с клиенти"
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
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Клиенти</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {data ? `${data.total} акаунта` : "Зареждане…"}
        </p>
      </div>

      {/* Filters */}
      <div className="rounded-lg border border-border bg-card p-3 mb-4 space-y-3">
        <form onSubmit={submitSearch} className="flex gap-2" role="search">
          <Input
            type="search"
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            placeholder="Име, имейл или фирма…"
            aria-label="Търсене по име, имейл или фирма"
            className="max-w-md"
          />
          <Button type="submit" variant="secondary" className="gap-1.5">
            <Search className="w-4 h-4" aria-hidden="true" />
            Търси
          </Button>
        </form>
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <label className="grid gap-1">
            <span className="text-xs text-muted-foreground">Тип акаунт</span>
            <select
              aria-label="Филтър по тип акаунт"
              className={selectClass}
              value={filters.accountType ?? ""}
              onChange={(e) =>
                applyFilter(
                  "accountType",
                  (e.target.value || undefined) as FilterState["accountType"],
                )
              }
            >
              <option value="">Всички</option>
              <option value="personal">Физическо лице</option>
              <option value="corporate">Фирма</option>
            </select>
          </label>
          <label className="grid gap-1">
            <span className="text-xs text-muted-foreground">Отстъпка</span>
            <select
              aria-label="Филтър по отстъпка"
              className={selectClass}
              value={filters.hasDiscount ?? ""}
              onChange={(e) =>
                applyFilter(
                  "hasDiscount",
                  (e.target.value || undefined) as FilterState["hasDiscount"],
                )
              }
            >
              <option value="">Всички</option>
              <option value="true">С отстъпка</option>
              <option value="false">Без отстъпка</option>
            </select>
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
          Няма клиенти, отговарящи на избраните критерии.
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="rounded-lg border border-border bg-card overflow-hidden hidden md:block">
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[640px]">
                <thead className="bg-muted/50 border-b border-border">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium">Клиент</th>
                    <th className="text-left px-4 py-3 font-medium">Тип</th>
                    <th className="text-left px-4 py-3 font-medium">Регистрация</th>
                    <th className="text-right px-4 py-3 font-medium">Поръчки</th>
                    <th className="text-left px-4 py-3 font-medium">Отстъпка</th>
                    <th className="px-4 py-3">
                      <span className="sr-only">Действия</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((c) => (
                    <tr
                      key={c.id}
                      className="border-b border-border last:border-0 hover:bg-muted/20"
                    >
                      <td className="px-4 py-3">
                        <p className="font-medium">{c.displayName}</p>
                        <p className="text-xs text-muted-foreground">{c.email}</p>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {c.accountType === "corporate" ? "Фирма" : "Физическо лице"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                        {formatDate(c.createdAt)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {c.orderCount}
                      </td>
                      <td className="px-4 py-3">
                        {c.discountPercent != null ? (
                          <Badge
                            variant="outline"
                            className="bg-primary/10 text-primary-strong border-primary/20"
                          >
                            {c.discountPercent}%
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onSelect(c.id)}
                        >
                          Виж
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Mobile card list */}
          <div className="md:hidden space-y-3">
            {data.items.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => onSelect(c.id)}
                className="block w-full text-left rounded-lg border border-border bg-white p-4 space-y-2 hover:bg-muted/20 transition-colors"
              >
                {/* Children are spans, not <div>/<p>: a <button> may only
                    contain phrasing content (invalid nesting → hydration error). */}
                <span className="flex items-start justify-between gap-2">
                  <span className="block min-w-0 flex-1">
                    <span className="block font-medium">{c.displayName}</span>
                    <span className="block text-xs text-muted-foreground truncate">
                      {c.email}
                    </span>
                  </span>
                  {c.discountPercent != null && (
                    <span className="flex-shrink-0 rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary-strong">
                      {c.discountPercent}%
                    </span>
                  )}
                </span>
                <span className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    {c.accountType === "corporate" ? "Фирма" : "Физическо лице"} ·{" "}
                    {c.orderCount} поръчки
                  </span>
                  <span className="flex items-center text-primary-strong">
                    Детайли <ChevronRight className="w-3 h-3 ml-0.5" aria-hidden="true" />
                  </span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {pagination && <div className="mt-3">{pagination}</div>}
    </div>
  );
}

// ─── Detail ────────────────────────────────────────────────────────────────

function CustomerDetailView({
  id,
  onBack,
  onChanged,
  onDeleted,
}: {
  id: string;
  onBack: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const router = useRouter();
  const [data, setData] = useState<AdminCustomerDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [percentDraft, setPercentDraft] = useState("");
  const [discountMsg, setDiscountMsg] = useState<string | null>(null);
  const [discountErr, setDiscountErr] = useState<string | null>(null);
  const [savingDiscount, setSavingDiscount] = useState(false);

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  const [deleteBlockers, setDeleteBlockers] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetchAdminCustomer(id);
      if (cancelled) return;
      if (res.ok) {
        setData(res.value);
        setPercentDraft(
          res.value.discount ? String(res.value.discount.percent) : "",
        );
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
  }, [id, reloadKey, router]);

  async function saveDiscount(e: React.FormEvent) {
    e.preventDefault();
    setDiscountErr(null);
    setDiscountMsg(null);
    const percent = Number(percentDraft.replace(",", "."));
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
      setDiscountErr("Въведете процент между 0 и 100 (напр. 15).");
      return;
    }
    setSavingDiscount(true);
    const res = await setCustomerDiscount(id, {
      percent,
      expectedAppliedAt: data?.discount?.appliedAt ?? null,
    });
    setSavingDiscount(false);
    if (res.ok) {
      setDiscountMsg("Отстъпката е запазена.");
      onChanged();
      setReloadKey((k) => k + 1);
      return;
    }
    if (res.error.kind === "not_admin") {
      router.refresh();
      return;
    }
    if (res.error.kind === "version_conflict") {
      setDiscountErr(
        "Отстъпката е променена другаде. Данните се презареждат — проверете и опитайте отново.",
      );
      setReloadKey((k) => k + 1);
      return;
    }
    setDiscountErr(errorMessage(res.error));
  }

  async function removeDiscount() {
    setDiscountErr(null);
    setDiscountMsg(null);
    setSavingDiscount(true);
    const res = await clearCustomerDiscount(id);
    setSavingDiscount(false);
    if (res.ok) {
      setDiscountMsg(
        res.value.cleared ? "Отстъпката е премахната." : "Няма активна отстъпка.",
      );
      setPercentDraft("");
      onChanged();
      setReloadKey((k) => k + 1);
      return;
    }
    if (res.error.kind === "not_admin") {
      router.refresh();
      return;
    }
    setDiscountErr(errorMessage(res.error));
  }

  async function doDelete() {
    setDeleteErr(null);
    setDeleteBlockers(null);
    setDeleting(true);
    const res = await deleteAdminCustomer(id);
    setDeleting(false);
    if (res.ok) {
      onDeleted();
      return;
    }
    if (res.error.kind === "not_admin") {
      router.refresh();
      return;
    }
    if (res.error.kind === "active_orders") {
      setDeleteBlockers(res.error.orderNumbers);
      setConfirmingDelete(false);
      return;
    }
    setDeleteErr(errorMessage(res.error));
  }

  return (
    <div>
      <Button variant="ghost" size="sm" onClick={onBack} className="mb-4 gap-1.5">
        <ArrowLeft className="w-4 h-4" aria-hidden="true" />
        Назад към списъка
      </Button>

      {loadError && (
        <p
          role="alert"
          aria-live="polite"
          className="mb-4 text-sm text-destructive bg-destructive/5 border border-destructive/20 rounded-md p-3"
        >
          {loadError}
        </p>
      )}

      {data === null ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-32 w-full rounded-lg" />
        </div>
      ) : (
        <div className="space-y-6">
          {/* Header */}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold">
                {data.personal?.fullName ??
                  data.corporate?.companyName ??
                  data.email}
              </h1>
              <p className="text-sm text-muted-foreground">{data.email}</p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline">
                {data.accountType === "corporate" ? "Фирма" : "Физическо лице"}
              </Badge>
              {!data.emailVerified && (
                <Badge
                  variant="outline"
                  className="bg-amber-50 text-amber-700 border-amber-200"
                >
                  Непотвърден имейл
                </Badge>
              )}
            </div>
          </div>

          {/* Profile */}
          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="text-sm font-semibold mb-3">Данни за акаунта</h2>
            <dl className="grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
              {data.personal && (
                <>
                  <Field label="Име" value={data.personal.fullName} />
                  <Field label="Телефон" value={data.personal.phone} />
                </>
              )}
              {data.corporate && (
                <>
                  <Field label="Фирма" value={data.corporate.companyName} />
                  <Field label="ЕИК" value={data.corporate.eik} />
                  <Field label="ДДС №" value={data.corporate.vatNumber ?? "—"} />
                  <Field label="МОЛ" value={data.corporate.mol} />
                  <Field
                    label="Седалище"
                    value={data.corporate.registeredAddress}
                  />
                  <Field label="Лице за контакт" value={data.corporate.contactName} />
                  <Field label="Тел. за контакт" value={data.corporate.contactPhone} />
                </>
              )}
              <Field label="Регистриран" value={formatDate(data.createdAt)} />
            </dl>
          </section>

          {/* Discount */}
          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="text-sm font-semibold mb-1">Персонална отстъпка</h2>
            <p className="text-xs text-muted-foreground mb-3">
              Прилага се към всички продукти при всяка поръчка от този акаунт.
              {data.discount
                ? ` Текуща: ${data.discount.percent}% — приложена от ${
                    data.discount.appliedByEmail ?? "администратор"
                  } на ${formatDate(data.discount.appliedAt)}.`
                : " В момента няма активна отстъпка."}
            </p>
            <form onSubmit={saveDiscount} className="flex flex-wrap items-end gap-3">
              <div className="grid gap-1">
                <label htmlFor="discount-percent" className="text-xs text-muted-foreground">
                  Процент (%)
                </label>
                <Input
                  id="discount-percent"
                  type="number"
                  min={0}
                  max={100}
                  step="0.01"
                  inputMode="decimal"
                  value={percentDraft}
                  onChange={(e) => setPercentDraft(e.target.value)}
                  className="w-28"
                  aria-describedby="discount-feedback"
                />
              </div>
              <Button type="submit" disabled={savingDiscount}>
                {savingDiscount ? "Запазване…" : "Запази отстъпката"}
              </Button>
              {data.discount && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={savingDiscount}
                  onClick={removeDiscount}
                >
                  Премахни
                </Button>
              )}
            </form>
            <p id="discount-feedback" aria-live="polite" className="mt-2 min-h-[1.25rem] text-sm">
              {discountErr ? (
                <span role="alert" className="text-destructive">
                  {discountErr}
                </span>
              ) : discountMsg ? (
                <span className="text-green-700">{discountMsg}</span>
              ) : null}
            </p>
          </section>

          {/* Orders */}
          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="text-sm font-semibold mb-3">
              История на поръчките{" "}
              <span className="text-muted-foreground font-normal">
                ({data.orderCount})
              </span>
            </h2>
            {data.orders.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Този акаунт няма поръчки.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {data.orders.map((o) => (
                  <li
                    key={o.orderNumber}
                    className="flex items-center justify-between gap-3 py-2 text-sm"
                  >
                    <div className="min-w-0">
                      <p className="font-medium">{o.orderNumber}</p>
                      <p className="text-xs text-muted-foreground">
                        {formatDate(o.createdAt)} · {o.itemCount} артикула
                      </p>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <Badge variant="outline">
                        {ORDER_STATUS_LABELS[o.status] ?? o.status}
                      </Badge>
                      <span className="font-semibold tabular-nums">
                        {formatCents(o.totalCents)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Danger zone — delete account */}
          <section className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
            <h2 className="text-sm font-semibold text-destructive mb-1">
              Изтриване на акаунта
            </h2>
            <p className="text-xs text-muted-foreground mb-3">
              Профилните данни се изтриват, а историята на поръчките се запазва
              псевдонимизирана (законово изискване за счетоводни документи).
              Действието е необратимо и е блокирано, докато има активни поръчки.
            </p>

            {deleteBlockers && deleteBlockers.length > 0 && (
              <div
                role="alert"
                className="mb-3 text-sm text-destructive bg-white border border-destructive/20 rounded-md p-3"
              >
                <p className="flex items-center gap-1.5 font-medium">
                  <AlertTriangle className="w-4 h-4" aria-hidden="true" />
                  Изтриването е блокирано — активни поръчки:
                </p>
                <p className="mt-1">{deleteBlockers.join(", ")}</p>
              </div>
            )}
            {deleteErr && (
              <p role="alert" className="mb-3 text-sm text-destructive">
                {deleteErr}
              </p>
            )}

            {confirmingDelete ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm">Сигурни ли сте?</span>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={deleting}
                  onClick={doDelete}
                >
                  {deleting ? "Изтриване…" : "Да, изтрий акаунта"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={deleting}
                  onClick={() => setConfirmingDelete(false)}
                >
                  Отказ
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10"
                onClick={() => {
                  setDeleteErr(null);
                  setDeleteBlockers(null);
                  setConfirmingDelete(true);
                }}
              >
                <Trash2 className="w-4 h-4" aria-hidden="true" />
                Изтрий акаунта
              </Button>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium break-words">{value}</dd>
    </div>
  );
}
