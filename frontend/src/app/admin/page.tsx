import { products } from "@/lib/mock-data/products";
import { orders } from "@/lib/mock-data/orders";
import { customers } from "@/lib/mock-data/customers";
import { formatPrice } from "@/lib/utils";
import { ShoppingBag, Users, Package, AlertTriangle } from "lucide-react";
import Link from "next/link";

function KpiCard({ title, value, sub, icon: Icon, href }: {
  title: string; value: string; sub: string; icon: React.ElementType; href: string;
}) {
  return (
    <Link href={href} className="rounded-lg border border-border bg-card p-5 hover:border-primary/40 transition-colors block card-lift">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-muted-foreground">{title}</p>
          <p className="text-2xl font-bold mt-1">{value}</p>
          <p className="text-xs text-muted-foreground mt-1">{sub}</p>
        </div>
        <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
          <Icon className="w-5 h-5 text-primary-strong" />
        </div>
      </div>
    </Link>
  );
}

export default function AdminDashboard() {
  const monthOrders = orders.filter((o) => o.createdAt.startsWith("2026-04"));
  const revenue = monthOrders.reduce((s, o) => s + o.total, 0);
  const outOfStock = products.filter((p) => p.stockStatus === "out_of_stock" && !p.isArchived);
  const processingOrders = orders.filter((o) => o.status === "processing");

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Табло</h1>

      {/* KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <KpiCard title="Поръчки (месец)" value={String(monthOrders.length)} sub="Апрел 2026" icon={ShoppingBag} href="/admin/orders" />
        <KpiCard title="Приходи (месец)" value={formatPrice(revenue)} sub="Апрел 2026" icon={ShoppingBag} href="/admin/orders" />
        <KpiCard title="Клиенти" value={String(customers.filter(c => c.isActive).length)} sub="Активни акаунти" icon={Users} href="/admin/customers" />
        <KpiCard title="Продукти" value={String(products.filter(p => !p.isArchived).length)} sub={outOfStock.length > 0 ? `${outOfStock.length} изчерпани` : "Всички налични"} icon={Package} href="/admin/products" />
      </div>

      {/* Alerts — only out-of-stock + pending orders */}
      {(outOfStock.length > 0 || processingOrders.length > 0) && (
        <section className="mb-8">
          <h2 className="font-semibold mb-3">Известия</h2>
          <div className="space-y-2">
            {processingOrders.length > 0 && (
              <Link href="/admin/orders" className="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm hover:bg-amber-100 transition-colors">
                <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0" />
                <span><strong>{processingOrders.length}</strong> поръчки чакат обработка</span>
              </Link>
            )}
            {outOfStock.map((p) => (
              <Link key={p.id} href="/admin/products" className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm hover:bg-red-100 transition-colors">
                <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0" />
                <span><strong>{p.name}</strong> – Изчерпано</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Recent orders */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">Последни поръчки</h2>
          <Link href="/admin/orders" className="text-sm text-primary-strong underline">Всички →</Link>
        </div>
        <div className="rounded-lg border border-border bg-card overflow-x-auto">
          <table className="w-full text-sm min-w-[500px]">
            <thead className="bg-muted/50 border-b border-border">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium">Номер</th>
                <th className="text-left px-4 py-2.5 font-medium">Клиент</th>
                <th className="text-left px-4 py-2.5 font-medium">Статус</th>
                <th className="text-right px-4 py-2.5 font-medium">Сума</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-3">
                    <Link href={`/admin/orders/${o.id}`} className="text-primary-strong underline font-medium">{o.orderNumber}</Link>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{o.customerEmail}</td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-muted">
                      {o.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-semibold">{formatPrice(o.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
