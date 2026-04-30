import { notFound } from "next/navigation";
import Link from "next/link";
import { getOrderById } from "@/lib/mock-data/orders";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Separator } from "@/components/ui/separator";
import { formatPrice, formatDate } from "@/lib/utils";
import {
  ArrowLeft, Truck, Store, Package,
  ExternalLink, CheckCircle, Clock, XCircle
} from "lucide-react";
import {
  Breadcrumb, BreadcrumbItem, BreadcrumbLink,
  BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

const statusConfig: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  processing:      { label: "Обработва се",         icon: Clock,        color: "text-amber-600" },
  shipped:         { label: "Изпратена",             icon: Truck,        color: "text-blue-600" },
  ready_for_pickup:{ label: "Готова за вземане",     icon: Store,        color: "text-blue-600" },
  delivered:       { label: "Доставена",             icon: Package,      color: "text-green-600" },
  accepted:        { label: "Приета",                icon: CheckCircle,  color: "text-green-600" },
  returned:        { label: "Върната",               icon: XCircle,      color: "text-destructive" },
  cancelled:       { label: "Отказана",              icon: XCircle,      color: "text-destructive" },
};

const deliveryLabels: Record<string, string> = {
  courier: "Доставка с куриер",
  pickup: "Вземане от магазин",
};

const paymentLabels: Record<string, string> = {
  cash_on_delivery: "Наложен платеж",
  prepayment: "Предплащане",
};

interface Props {
  params: Promise<{ id: string }>;
}

export default async function OrderDetailPage({ params }: Props) {
  const { id } = await params;
  const order = getOrderById(id);
  if (!order) notFound();

  const status = statusConfig[order.status] ?? { label: order.status, icon: Clock, color: "text-muted-foreground" };
  const StatusIcon = status.icon;
  const canCancel = ["processing"].includes(order.status);

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <Breadcrumb className="mb-6">
        <BreadcrumbList>
          <BreadcrumbItem><BreadcrumbLink render={<Link href="/account/orders" />}>Поръчки</BreadcrumbLink></BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem><BreadcrumbPage>{order.orderNumber}</BreadcrumbPage></BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {/* Header */}
      <div className="flex items-start justify-between mb-6 gap-4">
        <div>
          <h1 className="text-2xl font-bold">{order.orderNumber}</h1>
          <p className="text-sm text-muted-foreground mt-1">{formatDate(order.createdAt)}</p>
        </div>
        <div className={`flex items-center gap-2 font-semibold ${status.color}`}>
          <StatusIcon className="w-5 h-5" />
          <span>{status.label}</span>
        </div>
      </div>

      <div className="space-y-5">
        {/* Courier tracking */}
        {order.courierInfo && (
          <div className="rounded-lg border border-border p-4 bg-blue-50/50">
            <h2 className="font-semibold mb-2 flex items-center gap-2 text-blue-700">
              <Truck className="w-4 h-4" /> Проследяване на пратката
            </h2>
            <p className="text-sm">
              {order.courierInfo.company} – Товарителница:{" "}
              <span className="font-mono font-medium">{order.courierInfo.trackingNumber}</span>
            </p>
            {order.courierInfo.trackingUrl && (
              <a href={order.courierInfo.trackingUrl} target="_blank" rel="noopener noreferrer"
                className="text-sm text-primary hover:underline flex items-center gap-1 mt-1">
                Проследи онлайн <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
        )}

        {/* Items */}
        <div className="rounded-lg border border-border p-4">
          <h2 className="font-semibold mb-3">Продукти</h2>
          <div className="space-y-3">
            {order.items.map((item) => (
              <div key={item.productId} className="flex items-center gap-3">
                <div className="w-12 h-12 flex-shrink-0 rounded bg-muted overflow-hidden">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={item.imageUrl} alt={item.name} className="w-full h-full object-cover" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{item.name}</p>
                  <p className="text-xs text-muted-foreground">{item.code}</p>
                </div>
                <div className="text-right text-sm flex-shrink-0">
                  <p className="font-semibold">{formatPrice(item.price * item.quantity)}</p>
                  <p className="text-muted-foreground">{item.quantity} бр. × {formatPrice(item.price)}</p>
                </div>
              </div>
            ))}
          </div>
          <Separator className="my-3" />
          <div className="space-y-1 text-sm">
            <div className="flex justify-between text-muted-foreground">
              <span>Сума</span><span>{formatPrice(order.subtotal)}</span>
            </div>
            {order.discountAmount > 0 && (
              <div className="flex justify-between text-green-600">
                <span>Отстъпка</span><span>- {formatPrice(order.discountAmount)}</span>
              </div>
            )}
          </div>
          <Separator className="my-3" />
          <div className="flex justify-between font-bold text-base">
            <span>Общо</span>
            <span className="text-primary">{formatPrice(order.total)}</span>
          </div>
        </div>

        {/* Delivery & payment */}
        <div className="grid sm:grid-cols-2 gap-4">
          <div className="rounded-lg border border-border p-4">
            <h2 className="font-semibold mb-2">{deliveryLabels[order.deliveryMethod]}</h2>
            {order.deliveryAddress ? (
              <address className="text-sm not-italic text-muted-foreground">
                <p>{order.deliveryAddress.name}</p>
                <p>{order.deliveryAddress.street}</p>
                <p>{order.deliveryAddress.city} {order.deliveryAddress.postalCode}</p>
                <p>{order.deliveryAddress.phone}</p>
              </address>
            ) : (
              <p className="text-sm text-muted-foreground">Вземане от магазин</p>
            )}
          </div>
          <div className="rounded-lg border border-border p-4">
            <h2 className="font-semibold mb-2">Плащане</h2>
            <p className="text-sm text-muted-foreground">{paymentLabels[order.paymentMethod]}</p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-col sm:flex-row gap-3">
          <ButtonLink variant="outline" className="gap-2" href="/account/orders">
            <ArrowLeft className="w-4 h-4" /> Всички поръчки
          </ButtonLink>
          {canCancel && (
            <Button variant="destructive" className="sm:ml-auto">Откажи поръчката</Button>
          )}
        </div>
      </div>
    </div>
  );
}
