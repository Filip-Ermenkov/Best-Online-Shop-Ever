"use client";

/**
 * Admin dashboard — the real `/admin` landing screen (docs/README.md §"Табло").
 * Un-mocks the last high-traffic admin page, which until now rendered fabricated
 * numbers off `frontend/src/lib/mock-data/*`. Read-only: it fetches the whole
 * overview from `/admin/dashboard` (see backend routes/admin/dashboard.ts) via the
 * typed client in lib/admin/dashboard/.
 *
 * A flat 404 means the admin session expired → router.refresh() re-renders the
 * admin layout's AdminAuthGate (same contract as the other admin managers).
 *
 * Accessibility: the 14-day trend is an SVG `role="img"` with a descriptive label
 * AND a visually-hidden data table carrying the same numbers — the WCAG-recommended
 * "chart + tabular alternative" pattern, so the trend is fully available to screen
 * readers and never conveyed by colour alone.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  AlertTriangle,
  Banknote,
  Layers,
  Package,
  RefreshCw,
  Receipt,
  ShoppingBag,
  Users,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCents, formatDate } from "@/lib/utils";
import { fetchAdminDashboard } from "@/lib/admin/dashboard/client";
import type {
  AdminDashboardError,
  DashboardSummary,
} from "@/lib/admin/dashboard/types";

const STATUS_LABELS: Record<string, string> = {
  processing: "Обработва се",
  accepted: "Прието",
  ready_for_pickup: "Готово за вземане",
  shipped: "Изпратено",
  delivered: "Доставено",
  returned: "Върнато",
  cancelled: "Анулирано",
};

function errorMessage(err: AdminDashboardError): string {
  switch (err.kind) {
    case "network":
      return "Връзката със сървъра пропадна. Опитайте отново.";
    case "not_admin":
      return "Сесията изтече. Презаредете страницата.";
    default:
      return err.detail ?? "Възникна неочаквана грешка.";
  }
}

export default function DashboardManager() {
  const router = useRouter();
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    const res = await fetchAdminDashboard();
    setRefreshing(false);
    if (res.ok) {
      setData(res.value);
      setLoadError(null);
    } else if (res.error.kind === "not_admin") {
      router.refresh();
    } else {
      setLoadError(errorMessage(res.error));
    }
  }, [router]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetchAdminDashboard();
      if (cancelled) return;
      if (res.ok) {
        setData(res.value);
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

  if (loadError) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-6">Табло</h1>
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
        <h1 className="text-2xl font-bold mb-6">Табло</h1>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
        <Skeleton className="h-48 w-full mb-8" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const { month, today, newCustomers, actionQueue, catalog, lowStock, recentOrders } =
    data;

  const alerts: { key: string; tone: "amber" | "red"; href: string; label: string }[] =
    [];
  if (actionQueue.newOrders > 0) {
    alerts.push({
      key: "new-orders",
      tone: "amber",
      href: "/admin/orders",
      label: `${actionQueue.newOrders} ${actionQueue.newOrders === 1 ? "нова поръчка чака" : "нови поръчки чакат"} обработка`,
    });
  }
  if (actionQueue.expiredPickups > 0) {
    alerts.push({
      key: "expired-pickups",
      tone: "amber",
      href: "/admin/orders",
      label: `${actionQueue.expiredPickups} ${actionQueue.expiredPickups === 1 ? "поръчка с изтекъл срок" : "поръчки с изтекъл срок"} за вземане`,
    });
  }
  for (const p of lowStock) {
    alerts.push({
      key: `oos-${p.id}`,
      tone: "red",
      href: "/admin/products",
      label: `${p.name} (${p.code}) – изчерпано`,
    });
  }
  const extraOutOfStock = actionQueue.outOfStockProducts - lowStock.length;
  if (extraOutOfStock > 0) {
    alerts.push({
      key: "oos-more",
      tone: "red",
      href: "/admin/products",
      label: `още ${extraOutOfStock} изчерпани продукта`,
    });
  }

  const updatedAt = new Date(data.generatedAt).toLocaleTimeString("bg-BG", {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-6 gap-4">
        <h1 className="text-2xl font-bold">Табло</h1>
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
          <span className="sr-only"> данните на таблото</span>
        </button>
      </div>

      {/* KPIs — realised sales (cancelled/returned excluded) + new customers. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <KpiCard
          title="Поръчки (месец)"
          value={String(month.orders)}
          sub={`${today.orders} днес`}
          icon={ShoppingBag}
          href="/admin/orders"
        />
        <KpiCard
          title="Приходи (месец)"
          value={formatCents(month.revenueCents)}
          sub={`${formatCents(today.revenueCents)} днес`}
          icon={Banknote}
          href="/admin/orders"
        />
        <KpiCard
          title="Средна поръчка"
          value={formatCents(month.averageOrderValueCents)}
          sub="Този месец"
          icon={Receipt}
        />
        <KpiCard
          title="Нови клиенти (месец)"
          value={String(newCustomers.month)}
          sub={`${catalog.totalCustomers} общо`}
          icon={Users}
          href="/admin/customers"
        />
      </div>

      {/* Catalog snapshot */}
      <div className="grid grid-cols-3 gap-4 mb-8 text-sm">
        <SnapshotStat icon={Package} label="Активни продукти" value={catalog.activeProducts} href="/admin/products" />
        <SnapshotStat icon={Layers} label="Категории" value={catalog.activeCategories} href="/admin/categories" />
        <SnapshotStat icon={Users} label="Клиенти" value={catalog.totalCustomers} href="/admin/customers" />
      </div>

      {/* Attention / action queue */}
      <section className="mb-8" aria-labelledby="attention-heading">
        <h2 id="attention-heading" className="font-semibold mb-3">
          Изисква внимание
        </h2>
        {alerts.length === 0 ? (
          <p className="text-sm text-muted-foreground rounded-lg border border-border bg-card px-4 py-3">
            Няма задачи, изискващи внимание.
          </p>
        ) : (
          <ul className="space-y-2">
            {alerts.map((a) => (
              <li key={a.key}>
                <Link
                  href={a.href}
                  className={`flex items-center gap-3 rounded-lg border px-4 py-3 text-sm transition-colors ${
                    a.tone === "red"
                      ? "border-red-200 bg-red-50 hover:bg-red-100"
                      : "border-amber-200 bg-amber-50 hover:bg-amber-100"
                  }`}
                >
                  <AlertTriangle
                    className={`w-4 h-4 flex-shrink-0 ${a.tone === "red" ? "text-red-500" : "text-amber-600"}`}
                    aria-hidden="true"
                  />
                  <span>{a.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 14-day realised-sales trend */}
      <section className="mb-8">
        <OrdersTrendChart points={data.dailySeries} />
      </section>

      {/* Recent orders */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">Последни поръчки</h2>
          <Link href="/admin/orders" className="text-sm text-primary-strong underline">
            Всички →
          </Link>
        </div>
        {recentOrders.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center rounded-lg border border-border bg-card">
            Все още няма поръчки.
          </p>
        ) : (
          <div className="rounded-lg border border-border bg-card overflow-x-auto">
            <table className="w-full text-sm min-w-[560px]">
              <thead className="bg-muted/50 border-b border-border">
                <tr>
                  <th scope="col" className="text-left px-4 py-2.5 font-medium">Номер</th>
                  <th scope="col" className="text-left px-4 py-2.5 font-medium">Клиент</th>
                  <th scope="col" className="text-left px-4 py-2.5 font-medium">Дата</th>
                  <th scope="col" className="text-left px-4 py-2.5 font-medium">Статус</th>
                  <th scope="col" className="text-right px-4 py-2.5 font-medium">Сума</th>
                </tr>
              </thead>
              <tbody>
                {recentOrders.map((o) => (
                  <tr key={o.orderNumber} className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3">
                      <Link href={`/admin/orders/${o.orderNumber}`} className="text-primary-strong underline font-medium">
                        {o.orderNumber}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{o.customerName}</td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDate(o.createdAt)}</td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-muted">
                        {STATUS_LABELS[o.status] ?? o.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-semibold">{formatCents(o.totalCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="mt-6 text-xs text-muted-foreground">Обновено в {updatedAt} ч.</p>
    </div>
  );
}

// ─── KPI card ───────────────────────────────────────────────────────────────────

function KpiCard({
  title,
  value,
  sub,
  icon: Icon,
  href,
}: {
  title: string;
  value: string;
  sub: string;
  icon: React.ElementType;
  href?: string;
}) {
  const inner = (
    <div className="flex items-start justify-between">
      <div>
        <p className="text-sm text-muted-foreground">{title}</p>
        <p className="text-2xl font-bold mt-1">{value}</p>
        <p className="text-xs text-muted-foreground mt-1">{sub}</p>
      </div>
      <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
        <Icon className="w-5 h-5 text-primary-strong" aria-hidden="true" />
      </div>
    </div>
  );
  const cls =
    "rounded-lg border border-border bg-card p-5 block";
  return href ? (
    <Link href={href} className={`${cls} hover:border-primary/40 transition-colors card-lift`}>
      {inner}
    </Link>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

function SnapshotStat({
  icon: Icon,
  label,
  value,
  href,
}: {
  icon: React.ElementType;
  label: string;
  value: number;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 hover:border-primary/40 transition-colors"
    >
      <Icon className="w-5 h-5 text-muted-foreground flex-shrink-0" aria-hidden="true" />
      <span className="flex flex-col">
        <span className="text-lg font-bold leading-none">{value}</span>
        <span className="text-xs text-muted-foreground mt-1">{label}</span>
      </span>
    </Link>
  );
}

// ─── 14-day trend chart (accessible: SVG role=img + sr-only data table) ──────────

function shortDay(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString("bg-BG", {
    day: "2-digit",
    month: "2-digit",
  });
}

function OrdersTrendChart({ points }: { points: DashboardSummary["dailySeries"] }) {
  const totalOrders = points.reduce((s, p) => s + p.orders, 0);
  const totalRevenue = points.reduce((s, p) => s + p.revenueCents, 0);
  const maxOrders = Math.max(1, ...points.map((p) => p.orders));

  const W = 720;
  const H = 168;
  const padTop = 10;
  const padBottom = 26;
  const n = points.length;
  const gap = 8;
  const barW = (W - (n - 1) * gap) / n;
  const baseY = H - padBottom;
  const plotH = baseY - padTop;

  return (
    <figure className="rounded-lg border border-border bg-card p-5 m-0">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
        <span className="font-semibold">Поръчки — последните 14 дни</span>
        <span className="text-sm text-muted-foreground">
          Общо {totalOrders} {totalOrders === 1 ? "поръчка" : "поръчки"} · {formatCents(totalRevenue)}
        </span>
      </figcaption>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label={`Стълбовидна диаграма на поръчките по дни за последните 14 дни. Общо ${totalOrders} поръчки и ${formatCents(totalRevenue)} приходи. Подробните числа са в таблицата след диаграмата.`}
        className="block h-auto"
        preserveAspectRatio="xMidYMid meet"
      >
        {/* Axis baseline */}
        <g className="text-border">
          <line x1={0} y1={baseY} x2={W} y2={baseY} stroke="currentColor" strokeWidth={1} />
        </g>
        {/* Bars — colour via the accessible --primary-strong token (currentColor). */}
        <g className="text-primary-strong">
          {points.map((p, i) => {
            if (p.orders <= 0) return null;
            const x = i * (barW + gap);
            const h = Math.max(2, (p.orders / maxOrders) * plotH);
            return (
              <rect key={p.date} x={x} y={baseY - h} width={barW} height={h} rx={2} fill="currentColor">
                <title>{`${shortDay(p.date)}: ${p.orders} ${p.orders === 1 ? "поръчка" : "поръчки"}, ${formatCents(p.revenueCents)}`}</title>
              </rect>
            );
          })}
        </g>
        {/* Sparse date axis labels (every 3rd day) */}
        <g className="text-muted-foreground">
          {points.map((p, i) =>
            i % 3 === 0 ? (
              <text
                key={p.date}
                x={i * (barW + gap) + barW / 2}
                y={H - 8}
                textAnchor="middle"
                fill="currentColor"
                fontSize={10}
              >
                {shortDay(p.date)}
              </text>
            ) : null,
          )}
        </g>
      </svg>

      {/* Screen-reader equivalent of the chart (WCAG 1.1.1 text alternative). */}
      <table className="sr-only">
        <caption>Поръчки и приходи по дни за последните 14 дни</caption>
        <thead>
          <tr>
            <th scope="col">Дата</th>
            <th scope="col">Поръчки</th>
            <th scope="col">Приходи</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.date}>
              <td>{p.date}</td>
              <td>{p.orders}</td>
              <td>{formatCents(p.revenueCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
