"use client";

/**
 * Admin order detail — status actions, audit timeline, and full snapshots
 * (spec §"Управление на поръчки" + §7 "Действия на администратора по статус").
 *
 * The action buttons come from `detail.allowedTargets` — the SERVER's
 * state-machine verdict for this order — so the UI can never offer an
 * illegal hop. Irreversible actions go through the spec's confirmation
 * step (order summary + Потвърди / Назад) rendered inline, with the
 * companion fields the target requires (courier + tracking for
 * „Изпратена", deadline for „Готова за вземане", optional reason for
 * „Отказана"). A 409 (concurrent edit in another tab) shows the spec's
 * exact copy and auto-refreshes the data.
 *
 * Data loading follows the repo's proven client pattern (see
 * app/(shop)/account/orders/page.tsx): an inline async IIFE inside the
 * effect with a `cancelled` flag. The conflict path re-triggers the load
 * by bumping `reloadNonce` (an effect dependency) from the event handler.
 * The wall-clock for the expired-deadline mark is captured at load time
 * (`now` state) — render stays pure (no Date.now() during render).
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowLeft, Package, Store, Truck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCents, sanitizeImageUrl } from "@/lib/utils";
import {
  fetchAdminOrder,
  transitionAdminOrder,
} from "@/lib/admin/orders/client";
import type {
  AdminOrderDetail,
  TransitionTarget,
} from "@/lib/admin/orders/types";
import { ORDER_STATUS_CONFIG } from "@/components/admin/OrdersExplorer";

const ACTION_LABELS: Record<TransitionTarget, string> = {
  shipped: "Изпрати поръчката",
  ready_for_pickup: "Маркирай като готова за вземане",
  delivered: "Маркирай като доставена",
  accepted: "Маркирай като приета",
  returned: "Маркирай като върната",
  cancelled: "Откажи поръчката",
};

function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat("bg-BG", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Europe/Sofia",
  }).format(new Date(iso));
}

/** Local-time value for <input type="datetime-local"> (minute precision). */
function toDatetimeLocalValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface ConfirmState {
  target: TransitionTarget;
  courierCompany: string;
  trackingNumber: string;
  pickupDeadlineLocal: string;
  cancelledReason: string;
  note: string;
}

/** Built in event handlers only (Date.now() must not run during render). */
function emptyConfirm(target: TransitionTarget): ConfirmState {
  return {
    target,
    courierCompany: "",
    trackingNumber: "",
    // Sensible default: three days out, end of the working day. The admin
    // adjusts per order (the spec's settings-driven default is a future
    // slice — the settings admin UI does not exist yet).
    pickupDeadlineLocal: toDatetimeLocalValue(
      (() => {
        const d = new Date(Date.now() + 3 * 24 * 3600 * 1000);
        d.setHours(18, 0, 0, 0);
        return d;
      })(),
    ),
    cancelledReason: "",
    note: "",
  };
}

export default function OrderDetailPanel({ orderNumber }: { orderNumber: string }) {
  const router = useRouter();
  const [detail, setDetail] = useState<AdminOrderDetail | null>(null);
  const [now, setNow] = useState(0); // wall-clock captured per load
  const [reloadNonce, setReloadNonce] = useState(0);
  const [notFoundOrder, setNotFoundOrder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [conflictNotice, setConflictNotice] = useState(false);

  useEffect(() => {
    // `reloadNonce` is referenced so the dependency is "used": bumping it
    // from the conflict-refresh handler re-runs this load on demand.
    void reloadNonce;
    let cancelled = false;
    (async () => {
      const res = await fetchAdminOrder(orderNumber);
      if (cancelled) return;
      if (res.ok) {
        setNow(Date.now());
        setDetail(res.value);
        setError(null);
        return;
      }
      if (res.error.kind === "not_admin") {
        router.refresh(); // session expired → admin layout shows the gate
        return;
      }
      if (res.error.kind === "order_not_found") {
        setNotFoundOrder(true);
        return;
      }
      setError(
        res.error.kind === "network"
          ? "Не може да се свърже със сървъра. Проверете интернет връзката."
          : "Възникна неочаквана грешка при зареждането на поръчката.",
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [orderNumber, reloadNonce, router]);

  async function submitTransition() {
    if (!detail || !confirm) return;
    setSubmitting(true);
    setFieldErrors({});
    setError(null);
    const res = await transitionAdminOrder(detail.orderNumber, {
      status: confirm.target,
      expectedVersion: detail.version,
      ...(confirm.target === "shipped"
        ? {
            courierCompany: confirm.courierCompany.trim(),
            trackingNumber: confirm.trackingNumber.trim(),
          }
        : {}),
      ...(confirm.target === "ready_for_pickup"
        ? { pickupDeadline: new Date(confirm.pickupDeadlineLocal).toISOString() }
        : {}),
      ...(confirm.target === "cancelled" && confirm.cancelledReason.trim()
        ? { cancelledReason: confirm.cancelledReason.trim() }
        : {}),
      ...(confirm.note.trim() ? { note: confirm.note.trim() } : {}),
    });
    setSubmitting(false);
    if (res.ok) {
      setNow(Date.now());
      setDetail(res.value);
      setConfirm(null);
      return;
    }
    switch (res.error.kind) {
      case "version_conflict":
      case "invalid_transition":
        // Spec copy, verbatim: the order changed under us — refresh the view
        // (bumping the nonce re-runs the load effect).
        setConflictNotice(true);
        setConfirm(null);
        setReloadNonce((n) => n + 1);
        return;
      case "validation": {
        const fe: Record<string, string> = {};
        for (const f of res.error.fields) fe[f.path] = f.message;
        setFieldErrors(fe);
        if (Object.keys(fe).length === 0) {
          setError(res.error.detail ?? "Невалидни данни.");
        }
        return;
      }
      case "not_admin":
        router.refresh();
        return;
      case "order_not_found":
        setNotFoundOrder(true);
        return;
      default:
        setError(
          res.error.kind === "network"
            ? "Не може да се свърже със сървъра. Проверете интернет връзката."
            : "Възникна неочаквана грешка. Опитайте отново.",
        );
    }
  }

  if (notFoundOrder) {
    return (
      <div className="max-w-3xl">
        <ButtonLink variant="ghost" size="sm" href="/admin/orders" className="gap-1 mb-4">
          <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Назад
        </ButtonLink>
        <p role="alert" className="text-sm text-muted-foreground">
          Поръчка „{orderNumber}“ не беше намерена.
        </p>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="max-w-3xl space-y-4">
        <Skeleton className="h-8 w-72 rounded-md" />
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-28 w-full rounded-lg" />
        ))}
        {error && (
          <p role="alert" aria-live="polite" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    );
  }

  const statusCfg = ORDER_STATUS_CONFIG[detail.status];
  const pickupExpired =
    now > 0 &&
    detail.status === "ready_for_pickup" &&
    !!detail.pickupDeadline &&
    new Date(detail.pickupDeadline).getTime() < now;

  return (
    <div className="max-w-3xl">
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <ButtonLink variant="ghost" size="sm" href="/admin/orders" className="gap-1">
          <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Назад
        </ButtonLink>
        <h1 className="text-2xl font-bold">{detail.orderNumber}</h1>
        <Badge variant="outline" className={statusCfg.className}>
          {statusCfg.label}
        </Badge>
        {pickupExpired && (
          <span className="flex items-center gap-1 text-xs font-medium text-red-700">
            <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
            Изтекъл срок за вземане
          </span>
        )}
      </div>

      {conflictNotice && (
        <p
          role="alert"
          aria-live="polite"
          className="mb-4 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-md p-3"
        >
          Поръчката е вече актуализирана. Страницата ще се опресни автоматично.
        </p>
      )}
      {error && (
        <p
          role="alert"
          aria-live="polite"
          className="mb-4 text-sm text-destructive bg-destructive/5 border border-destructive/20 rounded-md p-3"
        >
          {error}
        </p>
      )}

      <div className="space-y-5">
        {/* Status actions — buttons mirror the SERVER's allowedTargets. */}
        <div className="rounded-lg border border-border bg-card p-4">
          <h2 className="font-semibold mb-3">Действия</h2>
          {detail.allowedTargets.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Поръчката е в краен статус — няма налични действия.
            </p>
          ) : confirm === null ? (
            <div className="flex flex-wrap gap-2">
              {detail.allowedTargets.map((target) => (
                <Button
                  key={target}
                  variant={target === "cancelled" ? "destructive" : "default"}
                  size="sm"
                  onClick={() => {
                    setConflictNotice(false);
                    setFieldErrors({});
                    setConfirm(emptyConfirm(target));
                  }}
                >
                  {ACTION_LABELS[target]}
                </Button>
              ))}
            </div>
          ) : (
            /* Inline confirmation step (spec: dialog with order summary +
               Потвърди / Назад). Inline keeps focus order linear — no trap.
               htmlFor + id on every field: the a11y rule can't see through
               the <Input> design-system wrapper. */
            <div className="space-y-3 border border-border rounded-md p-3 bg-muted/20">
              <p className="text-sm font-medium">
                {ACTION_LABELS[confirm.target]} — потвърждение
              </p>
              <p className="text-sm text-muted-foreground">
                Поръчка <strong>{detail.orderNumber}</strong> ·{" "}
                {detail.companyName ?? detail.customerName} ·{" "}
                {formatCents(detail.totalCents)}
              </p>

              {confirm.target === "shipped" && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="grid gap-1 text-sm" htmlFor="transition-courier">
                    <span>Куриерска фирма *</span>
                    <Input
                      id="transition-courier"
                      value={confirm.courierCompany}
                      onChange={(e) =>
                        setConfirm({ ...confirm, courierCompany: e.target.value })
                      }
                      aria-invalid={!!fieldErrors.courierCompany}
                    />
                    {fieldErrors.courierCompany && (
                      <span className="text-xs text-destructive">
                        Задължително поле
                      </span>
                    )}
                  </label>
                  <label className="grid gap-1 text-sm" htmlFor="transition-tracking">
                    <span>Номер на товарителница *</span>
                    <Input
                      id="transition-tracking"
                      value={confirm.trackingNumber}
                      onChange={(e) =>
                        setConfirm({ ...confirm, trackingNumber: e.target.value })
                      }
                      aria-invalid={!!fieldErrors.trackingNumber}
                    />
                    {fieldErrors.trackingNumber && (
                      <span className="text-xs text-destructive">
                        Задължително поле
                      </span>
                    )}
                  </label>
                </div>
              )}

              {confirm.target === "ready_for_pickup" && (
                <label className="grid gap-1 text-sm max-w-xs" htmlFor="transition-deadline">
                  <span>Краен срок за вземане *</span>
                  <Input
                    id="transition-deadline"
                    type="datetime-local"
                    value={confirm.pickupDeadlineLocal}
                    onChange={(e) =>
                      setConfirm({ ...confirm, pickupDeadlineLocal: e.target.value })
                    }
                    aria-invalid={!!fieldErrors.pickupDeadline}
                  />
                  {fieldErrors.pickupDeadline && (
                    <span className="text-xs text-destructive">
                      Срокът трябва да е в бъдещето
                    </span>
                  )}
                </label>
              )}

              {confirm.target === "cancelled" && (
                <label className="grid gap-1 text-sm" htmlFor="transition-reason">
                  <span>Причина за отказа (по избор, вижда се от клиента)</span>
                  <Input
                    id="transition-reason"
                    value={confirm.cancelledReason}
                    onChange={(e) =>
                      setConfirm({ ...confirm, cancelledReason: e.target.value })
                    }
                  />
                </label>
              )}

              <label className="grid gap-1 text-sm" htmlFor="transition-note">
                <span>Бележка към историята (по избор, вътрешна)</span>
                <Input
                  id="transition-note"
                  value={confirm.note}
                  onChange={(e) => setConfirm({ ...confirm, note: e.target.value })}
                />
              </label>

              <div className="flex gap-2 pt-1">
                <Button
                  size="sm"
                  variant={confirm.target === "cancelled" ? "destructive" : "default"}
                  disabled={
                    submitting ||
                    (confirm.target === "shipped" &&
                      (!confirm.courierCompany.trim() || !confirm.trackingNumber.trim())) ||
                    (confirm.target === "ready_for_pickup" &&
                      !confirm.pickupDeadlineLocal)
                  }
                  onClick={() => void submitTransition()}
                >
                  {submitting ? "Изпълнява се…" : "Потвърди"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={submitting}
                  onClick={() => {
                    setConfirm(null);
                    setFieldErrors({});
                  }}
                >
                  Назад
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Customer */}
        <div className="rounded-lg border border-border bg-card p-4">
          <h2 className="font-semibold mb-3">Клиент</h2>
          <div className="grid grid-cols-2 gap-y-1.5 text-sm">
            <span className="text-muted-foreground">Имена:</span>
            <span>{detail.customerName}</span>
            <span className="text-muted-foreground">Email:</span>
            <span className="break-all">{detail.customerEmail}</span>
            <span className="text-muted-foreground">Телефон:</span>
            <span>{detail.customerPhone}</span>
            <span className="text-muted-foreground">Тип:</span>
            <span>
              {detail.customerType === "corporate"
                ? "Фирма"
                : detail.customerType === "personal"
                  ? "Физическо лице"
                  : "Гост"}
            </span>
          </div>
          {detail.corporateData && (
            <>
              <Separator className="my-3" />
              <div className="grid grid-cols-2 gap-y-1.5 text-sm">
                <span className="text-muted-foreground">Фирма:</span>
                <span>{detail.corporateData.companyName}</span>
                <span className="text-muted-foreground">ЕИК:</span>
                <span>{detail.corporateData.eik}</span>
                {detail.corporateData.vatNumber && (
                  <>
                    <span className="text-muted-foreground">ДДС №:</span>
                    <span>{detail.corporateData.vatNumber}</span>
                  </>
                )}
                <span className="text-muted-foreground">МОЛ:</span>
                <span>{detail.corporateData.mol}</span>
                <span className="text-muted-foreground">Адрес на управление:</span>
                <span>{detail.corporateData.registeredAddress}</span>
              </div>
            </>
          )}
        </div>

        {/* Delivery / pickup */}
        <div className="rounded-lg border border-border bg-card p-4">
          <h2 className="font-semibold mb-3 flex items-center gap-2">
            {detail.paymentMethod === "cash_on_delivery" ? (
              <Truck className="w-4 h-4" aria-hidden="true" />
            ) : (
              <Store className="w-4 h-4" aria-hidden="true" />
            )}
            {detail.paymentMethod === "cash_on_delivery"
              ? "Доставка с куриер (наложен платеж)"
              : "Вземане от магазина (плащане на място)"}
          </h2>
          {detail.deliveryAddress && (
            <p className="text-sm text-muted-foreground">
              {detail.deliveryAddress.street}
              {detail.deliveryAddress.apartmentOrOffice
                ? `, ${detail.deliveryAddress.apartmentOrOffice}`
                : ""}
              , {detail.deliveryAddress.postalCode} {detail.deliveryAddress.city}
            </p>
          )}
          {(detail.courierCompany || detail.trackingNumber) && (
            <div className="mt-2 text-sm space-y-1">
              <p>
                <span className="text-muted-foreground">Куриер:</span>{" "}
                {detail.courierCompany}
              </p>
              <p>
                <span className="text-muted-foreground">Товарителница:</span>{" "}
                {detail.trackingNumber}
              </p>
            </div>
          )}
          {detail.pickupDeadline && (
            <p className={`mt-2 text-sm ${pickupExpired ? "text-red-700 font-medium" : ""}`}>
              <span className="text-muted-foreground">Краен срок за вземане:</span>{" "}
              {formatDateTime(detail.pickupDeadline)}
            </p>
          )}
          {detail.cancelledReason && (
            <p className="mt-2 text-sm">
              <span className="text-muted-foreground">Причина за отказ:</span>{" "}
              {detail.cancelledReason}
            </p>
          )}
        </div>

        {/* Items */}
        <div className="rounded-lg border border-border bg-card p-4">
          <h2 className="font-semibold mb-3 flex items-center gap-2">
            <Package className="w-4 h-4" aria-hidden="true" /> Продукти
          </h2>
          <div className="space-y-3">
            {detail.items.map((item, idx) => {
              const safeSrc = sanitizeImageUrl(item.productImageUrl);
              return (
                <div key={`${item.productCode}-${idx}`} className="flex items-center gap-3">
                  <div className="w-12 h-12 flex-shrink-0 rounded bg-muted overflow-hidden">
                    {safeSrc && (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        src={safeSrc}
                        alt={item.productName}
                        className="w-full h-full object-cover"
                      />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{item.productName}</p>
                    <p className="text-xs text-muted-foreground">
                      {item.productCode} · {item.quantity} бр. ·{" "}
                      {formatCents(item.unitPriceCents)}/бр.
                    </p>
                  </div>
                  <span className="text-sm font-semibold whitespace-nowrap">
                    {formatCents(item.unitPriceCents * item.quantity)}
                  </span>
                </div>
              );
            })}
          </div>
          <Separator className="my-3" />
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Междинна сума</span>
              <span>{formatCents(detail.subtotalCents)}</span>
            </div>
            {detail.discountAmountCents > 0 && (
              <div className="flex justify-between text-green-700">
                <span>Отстъпка ({detail.discountPercent}%)</span>
                <span>- {formatCents(detail.discountAmountCents)}</span>
              </div>
            )}
          </div>
          <Separator className="my-2" />
          <div className="flex justify-between font-bold">
            <span>Общо</span>
            <span className="text-primary-strong">{formatCents(detail.totalCents)}</span>
          </div>
        </div>

        {/* Status history (audit trail) */}
        <div className="rounded-lg border border-border bg-card p-4">
          <h2 className="font-semibold mb-3">Хронология на статусите</h2>
          <ol className="space-y-2">
            {detail.statusHistory.map((h) => (
              <li key={h.id} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="text-muted-foreground whitespace-nowrap tabular-nums">
                  {formatDateTime(h.changedAt)}
                </span>
                <Badge variant="outline" className={ORDER_STATUS_CONFIG[h.status].className}>
                  {ORDER_STATUS_CONFIG[h.status].label}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {h.changedByEmail ?? "система"}
                  {h.note ? ` — ${h.note}` : ""}
                </span>
              </li>
            ))}
          </ol>
        </div>

        <p className="text-xs text-muted-foreground">
          Поръчана: {formatDateTime(detail.createdAt)} · Обновена:{" "}
          {formatDateTime(detail.updatedAt)}
          {detail.acceptedAt ? ` · Приета: ${formatDateTime(detail.acceptedAt)}` : ""}
        </p>
      </div>
    </div>
  );
}
