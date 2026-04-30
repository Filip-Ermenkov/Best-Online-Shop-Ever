"use client";

import { useAuth } from "@/contexts/AuthContext";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import Link from "next/link";
import { getOrdersByCustomer } from "@/lib/mock-data/orders";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button-link";
import { formatPrice, formatDate } from "@/lib/utils";
import { Package, ChevronRight } from "lucide-react";

const statusConfig: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  processing: { label: "Обработва се", variant: "secondary" },
  shipped: { label: "Изпратена", variant: "default" },
  ready_for_pickup: { label: "Готова за вземане", variant: "default" },
  delivered: { label: "Доставена", variant: "outline" },
  accepted: { label: "Приета", variant: "outline" },
  returned: { label: "Върната", variant: "destructive" },
  cancelled: { label: "Отказана", variant: "destructive" },
};

export default function OrdersPage() {
  const { user, isLoggedIn } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoggedIn) router.push("/account/login");
  }, [isLoggedIn, router]);

  if (!user) return null;

  const orders = getOrdersByCustomer(user.id);

  return (
    <div className="max-w-3xl mx-auto px-4 py-10">
      <h1 className="text-2xl font-bold mb-6">Моите поръчки</h1>

      {orders.length === 0 ? (
        <div className="flex flex-col items-center py-20 text-center gap-4">
          <Package className="w-12 h-12 text-muted-foreground/40" />
          <div>
            <p className="font-medium">Нямате поръчки</p>
            <p className="text-sm text-muted-foreground mt-1">Вашите поръчки ще се появят тук.</p>
          </div>
          <ButtonLink href="/products">Разгледай продукти</ButtonLink>
        </div>
      ) : (
        <div className="space-y-4">
          {orders.map((order) => {
            const status = statusConfig[order.status] ?? { label: order.status, variant: "secondary" as const };
            return (
              <Link
                key={order.id}
                href={`/account/orders/${order.id}`}
                className="block rounded-lg border border-border p-4 hover:border-primary/50 hover:bg-muted/30 transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold">{order.orderNumber}</p>
                    <p className="text-sm text-muted-foreground mt-0.5">{formatDate(order.createdAt)}</p>
                    <p className="text-sm text-muted-foreground">
                      {order.items.length} {order.items.length === 1 ? "продукт" : "продукта"}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <Badge variant={status.variant}>{status.label}</Badge>
                    <span className="font-bold text-primary">{formatPrice(order.total)}</span>
                    <ChevronRight className="w-4 h-4 text-muted-foreground" />
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
