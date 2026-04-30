import Link from "next/link";
import { orders } from "@/lib/mock-data/orders";
import { formatPrice, formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Download, ChevronRight } from "lucide-react";

const statusConfig: Record<string, { label: string; className: string }> = {
  processing:       { label: "Обработва се", className: "bg-amber-100 text-amber-700 border-amber-200" },
  shipped:          { label: "Изпратена",    className: "bg-blue-100 text-blue-700 border-blue-200" },
  ready_for_pickup: { label: "За вземане",   className: "bg-blue-100 text-blue-700 border-blue-200" },
  delivered:        { label: "Доставена",    className: "bg-green-100 text-green-700 border-green-200" },
  accepted:         { label: "Приета",       className: "bg-green-100 text-green-700 border-green-200" },
  returned:         { label: "Върната",      className: "bg-red-100 text-red-700 border-red-200" },
  cancelled:        { label: "Отказана",     className: "bg-red-100 text-red-700 border-red-200" },
};

export default function AdminOrdersPage() {
  return (
    <div>
      <div className="flex items-center justify-between mb-6 gap-3">
        <div>
          <h1 className="text-2xl font-bold">Поръчки</h1>
          <p className="text-sm text-muted-foreground mt-1">{orders.length} поръчки</p>
        </div>
        <Button variant="outline" className="gap-2">
          <Download className="w-4 h-4" />
          <span className="hidden sm:inline">Експорт CSV</span>
        </Button>
      </div>

      {/* Desktop table */}
      <div className="rounded-lg border border-border bg-card overflow-hidden hidden md:block">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[600px]">
            <thead className="bg-muted/50 border-b border-border">
              <tr>
                <th className="text-left px-4 py-3 font-medium">Номер</th>
                <th className="text-left px-4 py-3 font-medium">Дата</th>
                <th className="text-left px-4 py-3 font-medium">Клиент</th>
                <th className="text-left px-4 py-3 font-medium">Статус</th>
                <th className="text-right px-4 py-3 font-medium">Сума</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => {
                const status = statusConfig[o.status] ?? { label: o.status, className: "bg-muted" };
                return (
                  <tr key={o.id} className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-3 font-medium">{o.orderNumber}</td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDate(o.createdAt)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{o.customerEmail}</td>
                    <td className="px-4 py-3">
                      <Badge variant="outline" className={status.className}>{status.label}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right font-semibold">{formatPrice(o.total)}</td>
                    <td className="px-4 py-3">
                      <ButtonLink variant="ghost" size="sm" href={`/admin/orders/${o.id}`}>Виж</ButtonLink>
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
        {orders.map((o) => {
          const status = statusConfig[o.status] ?? { label: o.status, className: "bg-muted" };
          return (
            <Link
              key={o.id}
              href={`/admin/orders/${o.id}`}
              className="block rounded-lg border border-border bg-white p-4 space-y-2 hover:bg-muted/20 transition-colors"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-sm">{o.orderNumber}</p>
                  <p className="text-xs text-muted-foreground truncate">{o.customerEmail}</p>
                </div>
                <Badge variant="outline" className={`${status.className} flex-shrink-0`}>
                  {status.label}
                </Badge>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-xs text-muted-foreground">{formatDate(o.createdAt)}</span>
                <span className="font-semibold">{formatPrice(o.total)}</span>
              </div>
              <div className="flex items-center justify-end text-xs text-primary pt-1 border-t border-border">
                Виж детайли <ChevronRight className="w-3 h-3 ml-0.5" />
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
