"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/contexts/AuthContext";
import { fetchOrders } from "@/lib/orders/client";
import type { OrderDTO, OrderStatus } from "@/lib/orders/types";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button-link";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCents, formatDate } from "@/lib/utils";
import { Package, ChevronRight } from "lucide-react";

/**
 * Visual config per OrderStatus. Mirrors the backend enum; if a new status
 * lands the fallback below preserves usability while the design catches up.
 */
const statusConfig: Record<
  OrderStatus,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  processing: { label: "Обработва се", variant: "secondary" },
  shipped: { label: "Изпратена", variant: "default" },
  ready_for_pickup: { label: "Готова за вземане", variant: "default" },
  delivered: { label: "Доставена", variant: "outline" },
  accepted: { label: "Приета", variant: "outline" },
  returned: { label: "Върната", variant: "destructive" },
  cancelled: { label: "Отказана", variant: "destructive" },
};

export default function OrdersPage() {
  const router = useRouter();
  const { isLoggedIn, status: authStatus } = useAuth();

  const [orders, setOrders] = useState<OrderDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Bounce anonymous visitors to login. We wait for the auth bootstrap to
  // settle ("loading" → known) before deciding, so a logged-in user with a
  // slow /auth/me round-trip doesn't get a flash of "redirecting".
  useEffect(() => {
    if (authStatus === "loading") return;
    if (!isLoggedIn) {
      router.push(
        `/account/login?next=${encodeURIComponent("/account/orders")}`,
      );
    }
  }, [authStatus, isLoggedIn, router]);

  // Load orders. Re-runs when auth flips authenticated (e.g. after login
  // round-trip). The fetch is best-effort — empty list is the default.
  useEffect(() => {
    if (!isLoggedIn) return;
    let cancelled = false;
    (async () => {
      const res = await fetchOrders();
      if (cancelled) return;
      if (res.ok) {
        setOrders(res.value);
        setError(null);
      } else if (res.error.kind === "unauthenticated") {
        // Cookie expired between page mount and this fetch. The auth
        // bootstrap will catch up on the next /auth/me poll; in the
        // meantime show an empty state rather than spinning forever.
        setOrders([]);
        setError(null);
      } else if (res.error.kind === "network") {
        setError(
          "Не може да се свърже със сървъра. Проверете интернет връзката.",
        );
      } else {
        setError("Възникна неочаквана грешка. Опитайте отново по-късно.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isLoggedIn]);

  // Loading skeleton — gives the page structure while orders load. Three
  // skeleton rows is enough visual feedback without over-promising.
  if (authStatus === "loading" || (isLoggedIn && orders === null)) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-10">
        <h1 className="text-2xl font-bold mb-6">Моите поръчки</h1>
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24 w-full rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  if (!isLoggedIn) return null;

  return (
    <div className="max-w-3xl mx-auto px-4 py-10">
      <h1 className="text-2xl font-bold mb-6">Моите поръчки</h1>

      {error && (
        <p
          role="alert"
          aria-live="polite"
          className="mb-4 text-sm text-destructive bg-destructive/5 border border-destructive/20 rounded-md p-3"
        >
          {error}
        </p>
      )}

      {orders && orders.length === 0 ? (
        <div className="flex flex-col items-center py-20 text-center gap-4">
          <Package className="w-12 h-12 text-muted-foreground/40" />
          <div>
            <p className="font-medium">Нямате поръчки</p>
            <p className="text-sm text-muted-foreground mt-1">
              Вашите поръчки ще се появят тук.
            </p>
          </div>
          <ButtonLink href="/products/electronics">
            Разгледай продукти
          </ButtonLink>
        </div>
      ) : (
        <div className="space-y-4">
          {orders?.map((order) => {
            const status = statusConfig[order.status] ?? {
              label: order.status,
              variant: "secondary" as const,
            };
            const totalQty = order.items.reduce(
              (sum, it) => sum + it.quantity,
              0,
            );
            return (
              <Link
                key={order.id}
                href={`/account/orders/${encodeURIComponent(order.orderNumber)}`}
                className="block rounded-lg border border-border p-4 hover:border-primary/50 hover:bg-muted/30 transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold">{order.orderNumber}</p>
                    <p className="text-sm text-muted-foreground mt-0.5">
                      {formatDate(order.createdAt)}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {totalQty}{" "}
                      {totalQty === 1 ? "продукт" : "продукта"}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <Badge variant={status.variant}>{status.label}</Badge>
                    <span className="font-bold text-primary">
                      {formatCents(order.totalCents)}
                    </span>
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
