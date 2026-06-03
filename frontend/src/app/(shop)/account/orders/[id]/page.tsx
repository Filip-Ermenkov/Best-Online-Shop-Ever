"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import {
  fetchOrder,
  fetchWithdrawalEligibility,
} from "@/lib/orders/client";
import type {
  OrderDTO,
  OrderStatus,
  WithdrawalEligibility,
} from "@/lib/orders/types";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCents, formatDate } from "@/lib/utils";
import {
  ArrowLeft, Truck, Store, Package,
  CheckCircle, Clock, XCircle, Banknote, ShieldX,
} from "lucide-react";
import {
  Breadcrumb, BreadcrumbItem, BreadcrumbLink,
  BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

/**
 * Order detail page — doubles as the post-checkout confirmation page.
 *
 * Two entry vectors:
 *   1. Just placed an order. The /checkout/review submit handler routes
 *      here on 201 with the orderNumber from POST /orders. We optionally
 *      show a success banner driven by ?confirm=1 (set by the redirect)
 *      so this otherwise-utility page becomes a celebratory landing.
 *   2. Browsing order history. Linked to from /account/orders. Identical
 *      data; just no banner.
 *
 * The dynamic segment is named `[id]` for legacy reasons but the value
 * IS the public orderNumber (e.g. "2026-05-00123"). Renaming the route
 * folder is a low-priority follow-up — every link to it already passes
 * an orderNumber, and the backend's GET /orders/:orderNumber is keyed on
 * exactly that string.
 *
 * Cancellation is intentionally NOT wired up in this slice — the backend
 * has no DELETE /orders/:n endpoint yet and the spec leaves cancellation
 * to admin-side workflow. A "currently cancellable" hint is left in the
 * statusConfig but the button is hidden until the cancel slice lands.
 */
const statusConfig: Record<
  OrderStatus,
  { label: string; icon: React.ElementType; color: string }
> = {
  processing:       { label: "Обработва се",         icon: Clock,        color: "text-amber-600"      },
  shipped:          { label: "Изпратена",             icon: Truck,        color: "text-blue-600"       },
  ready_for_pickup: { label: "Готова за вземане",     icon: Store,        color: "text-blue-600"       },
  delivered:        { label: "Доставена",             icon: Package,      color: "text-green-700"      },
  accepted:         { label: "Приета",                icon: CheckCircle,  color: "text-green-700"      },
  returned:         { label: "Върната",               icon: XCircle,      color: "text-destructive"    },
  cancelled:        { label: "Отказана",              icon: XCircle,      color: "text-destructive"    },
};

const paymentLabels: Record<string, string> = {
  cash_on_delivery: "Наложен платеж",
  pay_at_store: "Плащане на място",
};

interface Props {
  // Next.js 16 passes params as a Promise even into client components,
  // so we unwrap with React's `use()` hook.
  params: Promise<{ id: string }>;
}

export default function OrderDetailPage({ params }: Props) {
  const { id: orderNumber } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const showConfirm = searchParams.get("confirm") === "1";
  const { isLoggedIn, status: authStatus } = useAuth();

  const [order, setOrder] = useState<OrderDTO | null>(null);
  const [errorState, setErrorState] = useState<
    "none" | "not_found" | "network" | "unknown"
  >("none");

  // Withdrawal-button surface (EU Directive 2023/2673 Art. 11a, mandatory
  // 19 June 2026). We only fetch eligibility once the order is loaded AND
  // the order is in `accepted` status — saves a round trip for the
  // overwhelming majority of order detail views (most orders never reach
  // accepted, and most that do never need a withdrawal). The button is
  // rendered iff eligibility comes back `eligible: true`.
  const [withdrawal, setWithdrawal] = useState<WithdrawalEligibility | null>(
    null,
  );

  // Auth gate. Anonymous users can't see anyone's orders — bounce them to
  // login with a return-to so the post-login redirect lands them back here.
  useEffect(() => {
    if (authStatus === "loading") return;
    if (!isLoggedIn) {
      router.push(
        `/account/login?next=${encodeURIComponent(`/account/orders/${orderNumber}`)}`,
      );
    }
  }, [authStatus, isLoggedIn, orderNumber, router]);

  // Load the order. The backend returns 404 both for non-existent orders
  // AND for orders belonging to someone else — that's the
  // enumeration-resistant contract from the spec, which we can't and
  // shouldn't differentiate on the UI. Both branches show the same copy.
  useEffect(() => {
    if (!isLoggedIn) return;
    let cancelled = false;
    (async () => {
      const res = await fetchOrder(orderNumber);
      if (cancelled) return;
      if (res.ok) {
        setOrder(res.value);
        setErrorState("none");
      } else {
        setOrder(null);
        if (res.error.kind === "not_found") setErrorState("not_found");
        else if (res.error.kind === "network") setErrorState("network");
        else if (res.error.kind === "unauthenticated") {
          // Mid-flight session expiry. Bounce cleanly.
          router.push(
            `/account/login?next=${encodeURIComponent(`/account/orders/${orderNumber}`)}`,
          );
        } else setErrorState("unknown");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isLoggedIn, orderNumber, router]);

  // Fetch withdrawal eligibility ONLY for orders that have reached
  // `accepted`. The backend will respond with `eligible: false reason=
  // not_accepted` for anything else anyway — but pre-filtering on the FE
  // side avoids ~95% of pointless requests, and the order detail page is
  // hot.
  useEffect(() => {
    if (!order || order.status !== "accepted") {
      // Reset on order swap / non-accepted reload. The "proper" fix is a
      // data-fetching layer (TanStack Query / SWR / Suspense + use()) where
      // the cache key would handle this automatically; that's a separate
      // slice already on the deferred list. Until then, this is the same
      // rationale-commented pattern AuthContext / CartContext use.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setWithdrawal(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const res = await fetchWithdrawalEligibility(order.orderNumber);
      if (cancelled) return;
      if (res.ok) {
        setWithdrawal(res.value);
      } else {
        setWithdrawal(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [order]);

  // Loading skeleton.
  if (authStatus === "loading" || (isLoggedIn && order === null && errorState === "none")) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-40 w-full rounded-lg" />
        <Skeleton className="h-32 w-full rounded-lg" />
      </div>
    );
  }

  if (!isLoggedIn) return null;

  // Not-found / error states.
  if (errorState === "not_found") {
    return (
      <div className="max-w-md mx-auto px-4 py-20 text-center">
        <Package className="w-12 h-12 text-muted-foreground/40 mx-auto mb-4" />
        <h1 className="text-xl font-bold mb-2">Поръчката не е намерена</h1>
        <p className="text-muted-foreground mb-6 text-sm">
          Поръчка с номер {orderNumber} не съществува или принадлежи на друг акаунт.
        </p>
        <ButtonLink href="/account/orders">
          Към моите поръчки
        </ButtonLink>
      </div>
    );
  }
  if (errorState !== "none") {
    return (
      <div className="max-w-md mx-auto px-4 py-20 text-center">
        <h1 className="text-xl font-bold mb-2">Възникна грешка</h1>
        <p className="text-muted-foreground mb-6 text-sm">
          {errorState === "network"
            ? "Не може да се свърже със сървъра. Опитайте отново."
            : "Възникна неочаквана грешка. Опитайте отново по-късно."}
        </p>
        <Button onClick={() => router.refresh()}>Опитай отново</Button>
      </div>
    );
  }
  if (!order) return null;

  const status = statusConfig[order.status] ?? {
    label: order.status,
    icon: Clock,
    color: "text-muted-foreground",
  };
  const StatusIcon = status.icon;

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      {/* Confirmation banner — shown only when arriving from successful checkout */}
      {showConfirm && (
        <div className="mb-6 rounded-lg border border-green-200 bg-green-50 p-4 flex items-start gap-3">
          <CheckCircle className="w-5 h-5 text-green-700 flex-shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-semibold text-green-800">Поръчката е приета!</p>
            <p className="text-green-700 mt-0.5">
              Изпратихме потвърждение на {order.customerEmail}. Ще получите
              известие при промяна на статуса.
            </p>
          </div>
        </div>
      )}

      <Breadcrumb className="mb-6">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink render={<Link href="/account/orders" />}>
              Поръчки
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{order.orderNumber}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {/* Header */}
      <div className="flex items-start justify-between mb-6 gap-4">
        <div>
          <h1 className="text-2xl font-bold">{order.orderNumber}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {formatDate(order.createdAt)}
          </p>
        </div>
        <div className={`flex items-center gap-2 font-semibold ${status.color}`}>
          <StatusIcon className="w-5 h-5" />
          <span>{status.label}</span>
        </div>
      </div>

      <div className="space-y-5">
        {/* Items */}
        <div className="rounded-lg border border-border p-4">
          <h2 className="font-semibold mb-3">Продукти</h2>
          <div className="space-y-3">
            {order.items.map((item) => (
              <div key={item.productCode} className="flex items-center gap-3">
                <div className="w-12 h-12 flex-shrink-0 rounded bg-muted overflow-hidden">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={item.productImageUrl ?? "https://placehold.co/200x200/e2e8f0/94a3b8?text=N/A"}
                    alt={item.productName}
                    className="w-full h-full object-cover"
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{item.productName}</p>
                  <p className="text-xs text-muted-foreground">{item.productCode}</p>
                </div>
                <div className="text-right text-sm flex-shrink-0">
                  <p className="font-semibold">
                    {formatCents(item.unitPriceCents * item.quantity)}
                  </p>
                  <p className="text-muted-foreground">
                    {item.quantity} бр. × {formatCents(item.unitPriceCents)}
                  </p>
                </div>
              </div>
            ))}
          </div>
          <Separator className="my-3" />
          <div className="space-y-1 text-sm">
            <div className="flex justify-between text-muted-foreground">
              <span>Сума</span>
              <span>{formatCents(order.subtotalCents)}</span>
            </div>
            {order.discountAmountCents > 0 && (
              <div className="flex justify-between text-green-700">
                <span>
                  Отстъпка{" "}
                  {order.discountPercent > 0 && `(${order.discountPercent}%)`}
                </span>
                <span>- {formatCents(order.discountAmountCents)}</span>
              </div>
            )}
          </div>
          <Separator className="my-3" />
          <div className="flex justify-between font-bold text-base">
            <span>Общо</span>
            <span className="text-primary-strong">{formatCents(order.totalCents)}</span>
          </div>
        </div>

        {/* Delivery & payment */}
        <div className="grid sm:grid-cols-2 gap-4">
          <div className="rounded-lg border border-border p-4">
            <h2 className="font-semibold mb-2 flex items-center gap-2">
              {order.deliveryAddress ? (
                <Truck className="w-4 h-4" />
              ) : (
                <Store className="w-4 h-4" />
              )}
              {order.deliveryAddress ? "Доставка" : "Вземане от магазин"}
            </h2>
            {order.deliveryAddress ? (
              <address className="text-sm not-italic text-muted-foreground space-y-0.5">
                <p className="text-foreground font-medium">
                  {order.customerName}
                </p>
                <p>
                  {order.deliveryAddress.street}
                  {order.deliveryAddress.apartmentOrOffice
                    ? `, ${order.deliveryAddress.apartmentOrOffice}`
                    : ""}
                </p>
                <p>
                  {order.deliveryAddress.city}{" "}
                  {order.deliveryAddress.postalCode}
                </p>
                <p>{order.customerPhone}</p>
              </address>
            ) : (
              <p className="text-sm text-muted-foreground">
                Поръчката ще ви очаква в магазина. Ще получите известие, когато е готова.
              </p>
            )}
          </div>
          <div className="rounded-lg border border-border p-4">
            <h2 className="font-semibold mb-2 flex items-center gap-2">
              <Banknote className="w-4 h-4" />
              Плащане
            </h2>
            <p className="text-sm text-muted-foreground">
              {paymentLabels[order.paymentMethod] ?? order.paymentMethod}
            </p>
          </div>
        </div>

        {/* Corporate snapshot — only present for B2B orders */}
        {order.corporateData && (
          <div className="rounded-lg border border-border p-4">
            <h2 className="font-semibold mb-2">Фирмени данни</h2>
            <div className="grid sm:grid-cols-2 gap-y-1 text-sm">
              <span className="text-muted-foreground">Фирма:</span>
              <span>{order.corporateData.companyName}</span>
              <span className="text-muted-foreground">ЕИК:</span>
              <span>{order.corporateData.eik}</span>
              {order.corporateData.vatNumber && (
                <>
                  <span className="text-muted-foreground">ДДС №:</span>
                  <span>{order.corporateData.vatNumber}</span>
                </>
              )}
              <span className="text-muted-foreground">МОЛ:</span>
              <span>{order.corporateData.mol}</span>
              <span className="text-muted-foreground">Адрес:</span>
              <span>{order.corporateData.registeredAddress}</span>
            </div>
          </div>
        )}

        {/* Notes — admin-visible note attached at checkout */}
        {order.notes && (
          <div className="rounded-lg border border-border p-4">
            <h2 className="font-semibold mb-2">Забележка</h2>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">
              {order.notes}
            </p>
          </div>
        )}

        {/* Withdrawal button surface — required by EU Directive 2023/2673
            (Art. 11a of 2011/83/EU), mandatory 19 June 2026. The button MUST
            be (i) clearly labelled with unambiguous wording, (ii) easy to
            find, (iii) continuously available throughout the 14-day window.
            We render it as a dedicated card sitting above the standard
            navigation actions so it's the first thing the user sees if
            they're looking for it, but we do NOT render it as a destructive-
            looking warning either — recital 37 prohibits dark patterns in
            BOTH directions. */}
        {withdrawal && withdrawal.eligible && (
          <div className="rounded-lg border border-border p-4">
            <h2 className="font-semibold mb-2 flex items-center gap-2">
              <ShieldX className="w-4 h-4" />
              14-дневно право на отказ
            </h2>
            {withdrawal.alreadySubmittedAt ? (
              <>
                <p className="text-sm text-muted-foreground mb-3">
                  Вече сте подали отказ за тази поръчка. Прегледайте
                  потвърждението си по всяко време.
                </p>
                <ButtonLink
                  variant="outline"
                  href={`/account/orders/${order.orderNumber}/withdrawal`}
                  className="w-full sm:w-auto"
                >
                  Прегледай отказа
                </ButtonLink>
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground mb-3">
                  По чл. 50 от Закона за защита на потребителите имате право да
                  се откажете от тази поръчка в рамките на 14 дни от датата на
                  получаване, без да посочвате причина.{" "}
                  <Link
                    href="/terms/withdrawal"
                    className="underline underline-offset-2 hover:text-foreground"
                  >
                    Прочетете пълните условия
                  </Link>
                  .
                </p>
                <ButtonLink
                  href={`/account/orders/${order.orderNumber}/withdrawal`}
                  className="w-full sm:w-auto"
                  aria-label="Откажете се от договора тук"
                >
                  Откажете се от договора тук
                </ButtonLink>
              </>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-col sm:flex-row gap-3">
          <ButtonLink variant="outline" className="gap-2" href="/account/orders">
            <ArrowLeft className="w-4 h-4" /> Всички поръчки
          </ButtonLink>
          <ButtonLink href="/products" className="sm:ml-auto">
            Продължи пазаруването
          </ButtonLink>
        </div>
      </div>
    </div>
  );
}
