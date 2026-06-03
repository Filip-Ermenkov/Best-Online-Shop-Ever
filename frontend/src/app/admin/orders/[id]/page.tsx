"use client";

import { notFound } from "next/navigation";
import { use } from "react";
import { useState } from "react";
import { ArrowLeft, Truck, Store, Package } from "lucide-react";
import { getOrderById } from "@/lib/mock-data/orders";
import { formatPrice, formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button-link";
import { Separator } from "@/components/ui/separator";
import WaybillDialog from "@/components/admin/WaybillDialog";

const statusConfig: Record<string, { label: string; className: string }> = {
  processing:       { label: "Обработва се", className: "bg-amber-100 text-amber-700 border-amber-200" },
  shipped:          { label: "Изпратена",    className: "bg-blue-100 text-blue-700 border-blue-200" },
  ready_for_pickup: { label: "За вземане",   className: "bg-blue-100 text-blue-700 border-blue-200" },
  delivered:        { label: "Доставена",    className: "bg-green-100 text-green-700 border-green-200" },
  accepted:         { label: "Приета",       className: "bg-green-100 text-green-700 border-green-200" },
  returned:         { label: "Върната",      className: "bg-red-100 text-red-700 border-red-200" },
  cancelled:        { label: "Отказана",     className: "bg-red-100 text-red-700 border-red-200" },
};

const allStatuses = ["processing", "shipped", "ready_for_pickup", "delivered", "accepted", "returned", "cancelled"] as const;
const paymentLabels: Record<string, string> = { cash_on_delivery: "Наложен платеж", pay_at_store: "Плащане на място" };

interface Props {
  params: Promise<{ id: string }>;
}

export default function AdminOrderDetailPage({ params }: Props) {
  const { id } = use(params);
  const orderData = getOrderById(id);
  if (!orderData) notFound();
  const order = orderData;

  const [status, setStatus] = useState(order.status);
  const [saved, setSaved] = useState(false);

  function handleStatusChange(newStatus: string) {
    setStatus(newStatus as typeof order.status);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  const statusInfo = statusConfig[status] ?? { label: status, className: "bg-muted" };

  return (
    <div className="max-w-3xl">
      <div className="flex items-center gap-3 mb-6">
        <ButtonLink variant="ghost" size="sm" href="/admin/orders" className="gap-1">
          <ArrowLeft className="w-4 h-4" /> Назад
        </ButtonLink>
        <h1 className="text-2xl font-bold">{order.orderNumber}</h1>
        <Badge variant="outline" className={statusInfo.className}>{statusInfo.label}</Badge>
      </div>

      <div className="space-y-5">
        {/* Status update */}
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm font-medium">Статус:</span>
            <select
              value={status}
              onChange={(e) => handleStatusChange(e.target.value)}
              className="text-sm border border-input rounded-md px-3 py-1.5 bg-background focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {allStatuses.map((s) => (
                <option key={s} value={s}>{statusConfig[s]?.label ?? s}</option>
              ))}
            </select>
            {saved && <span className="text-xs text-green-700 font-medium">✓ Запазено</span>}
            {order.deliveryMethod === "courier" && <WaybillDialog order={order} />}
          </div>
        </div>

        {/* Customer info */}
        <div className="rounded-lg border border-border bg-card p-4">
          <h2 className="font-semibold mb-3">Клиент</h2>
          <div className="grid grid-cols-2 gap-y-1.5 text-sm">
            <span className="text-muted-foreground">Email:</span>
            <span>{order.customerEmail}</span>
            {order.deliveryAddress && (
              <>
                <span className="text-muted-foreground">Имена:</span>
                <span>{order.deliveryAddress.name}</span>
                <span className="text-muted-foreground">Телефон:</span>
                <span>{order.deliveryAddress.phone}</span>
              </>
            )}
          </div>
        </div>

        {/* Delivery */}
        <div className="rounded-lg border border-border bg-card p-4">
          <h2 className="font-semibold mb-3 flex items-center gap-2">
            {order.deliveryMethod === "courier" ? <Truck className="w-4 h-4" /> : <Store className="w-4 h-4" />}
            {order.deliveryMethod === "courier" ? "Доставка с куриер" : "Вземане от магазин"}
          </h2>
          {order.deliveryAddress && (
            <p className="text-sm text-muted-foreground">
              {order.deliveryAddress.street}, {order.deliveryAddress.city} {order.deliveryAddress.postalCode}
            </p>
          )}
          {order.courierInfo && (
            <div className="mt-2 text-sm space-y-1">
              <p><span className="text-muted-foreground">Куриер:</span> {order.courierInfo.company}</p>
              <p><span className="text-muted-foreground">Товарителница:</span> {order.courierInfo.trackingNumber}</p>
              {order.courierInfo.trackingUrl && (
                <a href={order.courierInfo.trackingUrl} target="_blank" rel="noopener noreferrer" className="text-primary-strong underline">
                  Проследи пратката →
                </a>
              )}
            </div>
          )}
        </div>

        {/* Payment */}
        <div className="rounded-lg border border-border bg-card p-4">
          <h2 className="font-semibold mb-1">Плащане</h2>
          <p className="text-sm">{paymentLabels[order.paymentMethod] ?? order.paymentMethod}</p>
        </div>

        {/* Items */}
        <div className="rounded-lg border border-border bg-card p-4">
          <h2 className="font-semibold mb-3 flex items-center gap-2"><Package className="w-4 h-4" /> Продукти</h2>
          <div className="space-y-3">
            {order.items.map((item) => (
              <div key={item.productId} className="flex items-center gap-3">
                <div className="w-12 h-12 flex-shrink-0 rounded bg-muted overflow-hidden">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={item.imageUrl} alt={item.name} className="w-full h-full object-cover" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{item.name}</p>
                  <p className="text-xs text-muted-foreground">{item.code} · {item.quantity} бр.</p>
                </div>
                <span className="text-sm font-semibold whitespace-nowrap">{formatPrice(item.price * item.quantity)}</span>
              </div>
            ))}
          </div>
          <Separator className="my-3" />
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Сума</span>
              <span>{formatPrice(order.subtotal)}</span>
            </div>
            {order.discountAmount > 0 && (
              <div className="flex justify-between text-green-700">
                <span>Отстъпка</span>
                <span>- {formatPrice(order.discountAmount)}</span>
              </div>
            )}
          </div>
          <Separator className="my-2" />
          <div className="flex justify-between font-bold">
            <span>Общо</span>
            <span className="text-primary-strong">{formatPrice(order.total)}</span>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          Поръчана: {formatDate(order.createdAt)} · Обновена: {formatDate(order.updatedAt)}
        </p>
      </div>
    </div>
  );
}
