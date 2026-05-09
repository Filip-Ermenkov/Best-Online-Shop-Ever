"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { useCart } from "@/contexts/CartContext";
import { useAuth } from "@/contexts/AuthContext";
import { CheckoutFormData } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Separator } from "@/components/ui/separator";
import { formatCents } from "@/lib/utils";
import { CheckCircle, ArrowLeft, Truck, Store, Banknote } from "lucide-react";
import { getOfficeById } from "@/lib/mock-data/courier-offices";
import { placeOrder } from "@/lib/orders/client";
import type { OrderError, PlaceOrderInput } from "@/lib/orders/types";

const deliveryLabels = { courier: "Доставка с куриер", pickup: "Вземане от магазин" };
const paymentLabels: Record<string, string> = { cash_on_delivery: "Наложен платеж", pay_at_store: "Плащане на място" };
const courierLabels: Record<string, string> = { econt: "Еконт", speedy: "Спиди" };

/**
 * Generate a fresh idempotency key. Browser-native crypto.randomUUID is
 * available in every browser since 2022 and in Node ≥ 19. Per IETF
 * httpapi-idempotency-key (and Stripe / Adyen / MDN guidance), the *client*
 * is responsible for generation, and a v4 UUID is the recommended shape.
 */
function freshIdempotencyKey(): string {
  return crypto.randomUUID();
}

/**
 * Read the checkout draft from sessionStorage at render time via
 * useSyncExternalStore. The draft is written by the previous page
 * (/checkout) and is only ever READ here — it doesn't mutate during this
 * page's lifetime, so the `subscribe` callback is a no-op.
 *
 * Why this and not `useState + useEffect(setState)`:
 *   • `setState` inside `useEffect` is exactly the pattern
 *     `react-hooks/set-state-in-effect` (new in React 19) flags as a perf
 *     anti-pattern (extra render after mount).
 *   • A lazy `useState` initialiser would run on the SSR pass (where
 *     `window` is undefined) and never re-run on the client, so the read
 *     would always come back empty.
 *   • `useSyncExternalStore` properly separates the SSR snapshot
 *     (`getCheckoutServerSnapshot` returns null → component renders
 *     nothing during SSR) from the client snapshot (reads sessionStorage
 *     post-hydration), and React handles the transition without a
 *     hydration-mismatch warning.
 */
const CHECKOUT_DRAFT_KEY = "checkoutData";
function subscribeNoop(): () => void {
  return () => {};
}
function getCheckoutDraftSnapshot(): string | null {
  return sessionStorage.getItem(CHECKOUT_DRAFT_KEY);
}
function getCheckoutDraftServerSnapshot(): string | null {
  return null;
}

export default function CheckoutReviewPage() {
  const router = useRouter();
  const { items, subtotalCents, isAuthenticated, clearCart } = useCart();
  const { user, status: authStatus } = useAuth();

  const savedRaw = useSyncExternalStore(
    subscribeNoop,
    getCheckoutDraftSnapshot,
    getCheckoutDraftServerSnapshot,
  );
  const formData = useMemo<CheckoutFormData | null>(
    () => (savedRaw ? (JSON.parse(savedRaw) as CheckoutFormData) : null),
    [savedRaw],
  );

  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Idempotency-Key handling.
   *
   * The user's "intent to place this order" is the moment they land on this
   * review screen. We generate ONE key on first mount and store it in a
   * ref so the value is preserved across re-renders without participating
   * in React's render cycle. All retries — network blips, transient 5xx,
   * even resubmits after a recoverable error — reuse the same key. The
   * server's replay logic then guarantees we never double-charge.
   *
   * We regenerate on:
   *   - The very rare /problems/idempotency-conflict 409 (cross-customer
   *     UUID collision; ~zero with v4 but spec'd anyway), so the next
   *     attempt has a fresh key.
   *   - Page unmount → remount (e.g. user goes back to /checkout, edits,
   *     and comes back) — the ref is re-initialised on mount.
   */
  const idempotencyKeyRef = useRef<string | null>(null);
  if (idempotencyKeyRef.current === null) {
    // Lazy init — runs once per mount. Avoids the "useEffect for default
    // state" anti-pattern and the SSR mismatch that would come from
    // running crypto.randomUUID() during render on the server. Render is
    // only invoked client-side here ("use client"), so this is safe.
    idempotencyKeyRef.current = freshIdempotencyKey();
  }

  // Side effect (navigation) is the only thing left for useEffect to do
  // here — formData is now derived from savedRaw above, no setState needed.
  useEffect(() => {
    if (savedRaw === null) router.replace("/checkout");
  }, [savedRaw, router]);

  // TODO(auth slice 2): the public /auth/me endpoint does not yet expose
  // the customer discount. Backend stores it on users.customer_discount_percent
  // and applies it at order creation. Setting to 0 here keeps the UI numbers
  // consistent with what the backend will price the order at.
  const discountPercent = 0;
  const discountAmountCents = Math.round(subtotalCents * (discountPercent / 100));
  const totalCents = subtotalCents - discountAmountCents;

  if (!formData) return null;

  /**
   * Translate every branch of OrderError into Bulgarian copy. Centralised
   * so the UI text stays consistent and the switch is exhaustive — TS
   * will flag any new error variant added to the union.
   */
  function translateError(err: OrderError): string {
    switch (err.kind) {
      case "validation":
        // Field-level errors come back as { path, message }. The most
        // common case here is "deliveryAddress required for cash_on_delivery";
        // we surface the first field's message if present, otherwise a
        // generic copy. The backend's messages are English; we override
        // for known paths and fall back to generic Bulgarian.
        if (err.fields.some((f) => f.path === "deliveryAddress")) {
          return "Моля, посочете адрес за доставка при наложен платеж.";
        }
        return err.detail ?? "Невалидни данни за поръчката. Проверете полетата и опитайте отново.";
      case "unauthenticated":
        return "Сесията Ви е изтекла. Моля, влезте отново.";
      case "email_not_verified":
        return "Моля, потвърдете email адреса си преди да направите поръчка.";
      case "out_of_stock":
        if (err.offendingCodes.length > 0) {
          return `Някои продукти не са налични: ${err.offendingCodes.join(", ")}. Премахнете ги от количката и опитайте отново.`;
        }
        return "Някои продукти в количката не са налични. Премахнете ги и опитайте отново.";
      case "idempotency_conflict":
        return "Възникна конфликт при обработката. Опитайте отново.";
      case "cart_empty":
        return "Количката е празна. Добавете продукти, за да направите поръчка.";
      case "profile_required":
        return "Моля, попълнете профила си преди да направите поръчка.";
      case "not_found":
        // Not expected on POST /orders, listed for exhaustive type-checking.
        return "Поръчката не е намерена.";
      case "network":
        return "Не може да се свърже със сървъра. Проверете интернет връзката и опитайте отново.";
      case "unknown":
        return err.detail ?? `Възникна неочаквана грешка (HTTP ${err.status}). Опитайте отново.`;
    }
  }

  /**
   * Build the POST /orders body from the in-flight CheckoutFormData.
   * The backend validates conditional shape — deliveryAddress required iff
   * paymentMethod === "cash_on_delivery", forbidden otherwise (well,
   * silently dropped for "pay_at_store"). We mirror that conditional here.
   *
   * Address composition: the backend's DeliveryAddressInput has 4 fields
   * (city, postalCode, street, optional apartmentOrOffice). The current
   * checkout form has either an address (street/city/postalCode/country)
   * or an officeId pick. For the office case we synthesise a one-line
   * address from the office record because the backend has no
   * "courier office" concept yet — the order_delivery_address row carries
   * the office name + address as the street; future couriers slice will
   * formalise this with a separate column.
   */
  function buildOrderInput(data: CheckoutFormData): PlaceOrderInput | null {
    const base: PlaceOrderInput = {
      paymentMethod: data.paymentMethod,
    };

    if (data.paymentMethod !== "cash_on_delivery") {
      return base;
    }

    // cash_on_delivery requires an address. Source it from either the
    // typed address fields or the picked courier office.
    if (data.deliveryMethod === "courier" && data.deliveryType === "to_address" && data.address) {
      return {
        ...base,
        deliveryAddress: {
          city: data.address.city.trim(),
          postalCode: data.address.postalCode.trim(),
          street: data.address.street.trim(),
        },
      };
    }
    if (data.deliveryMethod === "courier" && data.deliveryType === "to_office" && data.officeId) {
      const office = getOfficeById(data.officeId);
      if (!office) return null;
      // The CourierOffice type doesn't carry an explicit postalCode field — the
      // mock embeds the 4-digit Bulgarian postal code at the end of the address
      // string ("ул. Сердика 4, София 1000"). Extract it via regex; fall back
      // to "0000" only as a last-ditch sentinel — the backend's min(1) check
      // would still pass and the order_delivery_address row carries the full
      // human-readable address in `street` either way. The dedicated couriers
      // slice (deferred) will formalise office records with proper postcode
      // columns and let us drop this regex.
      const postalMatch = office.address.match(/\b(\d{4})\b/);
      const postalCode = postalMatch?.[1] ?? "0000";
      return {
        ...base,
        deliveryAddress: {
          city: office.city,
          postalCode,
          street: `${office.name} — ${office.address}`,
          apartmentOrOffice: office.name,
        },
      };
    }
    // Pickup with cash_on_delivery is a quirky combination — the spec
    // forbids it implicitly (cash on delivery means a courier delivers).
    // The form should have prevented it, but we guard anyway.
    return null;
  }

  async function handleConfirm() {
    if (!formData) return;
    setError(null);

    // Pre-flight UX guards. These don't *need* to be here — the backend
    // would reject with 401 / 422 / 400 anyway — but skipping the network
    // round-trip on a clear user-state error is faster and friendlier.
    if (authStatus !== "authenticated" || !isAuthenticated || !user) {
      router.push(`/account/login?next=${encodeURIComponent("/checkout/review")}`);
      return;
    }
    if (items.length === 0) {
      setError("Количката е празна. Добавете продукти, за да направите поръчка.");
      return;
    }

    const input = buildOrderInput(formData);
    if (!input) {
      setError("Моля, посочете адрес или офис за доставка.");
      return;
    }

    setPlacing(true);
    try {
      const idempotencyKey = idempotencyKeyRef.current!;
      const res = await placeOrder(input, idempotencyKey);

      if (res.ok) {
        // Backend has already DELETE'd the cart_items rows inside the
        // checkout transaction. The CartContext's local `items` state,
        // however, is purely client-side and only re-syncs on auth-flip
        // or explicit mutation — neither of which fires on a successful
        // /orders POST. Without explicit help, the cart drawer would
        // keep showing the now-stale lines until the next reload. So
        // we call clearCart() here, which (in the authenticated branch)
        // round-trips DELETE /cart — idempotent against an already-empty
        // cart on the server side — and updates the local view.
        //
        // We deliberately don't await: the navigation is the user's
        // intent and shouldn't be delayed by a cart sync round-trip.
        // The server is already in the right state; this is purely a
        // client-side cleanup, and a stray failure (very unlikely on a
        // freshly-emptied cart) doesn't affect the order at all.
        void clearCart();
        sessionStorage.removeItem("checkoutData");
        sessionStorage.removeItem("checkoutOffice");
        // ?confirm=1 turns the destination into a celebratory landing
        // (green success banner). On regular history-navigation visits to
        // the same page the param is absent and only the order detail
        // shows. The query param is intentionally lightweight — no PII.
        router.push(
          `/account/orders/${encodeURIComponent(res.value.orderNumber)}?confirm=1`,
        );
        // refresh() so any Server Component reading auth/cart state
        // re-renders with the post-checkout truth.
        router.refresh();
        return;
      }

      // Map errors into copy. Some kinds also need extra side-effects:
      switch (res.error.kind) {
        case "unauthenticated":
          // Cookie expired between page load and submit. Bounce to login
          // with a return-to so the user resumes seamlessly after re-auth.
          router.push(`/account/login?next=${encodeURIComponent("/checkout/review")}`);
          return;
        case "idempotency_conflict":
          // Cross-customer UUID collision. Regenerate the key so the next
          // submit has a fresh one. The user can click "Потвърди" again.
          idempotencyKeyRef.current = freshIdempotencyKey();
          setError(translateError(res.error));
          return;
        case "cart_empty":
          // Whole cart was soft-deleted between page load and submit. No
          // recovery on this screen — send the user back to /checkout.
          setError(translateError(res.error));
          // Best-effort: clear the stale checkoutData so a fresh attempt
          // doesn't replay the same intent.
          sessionStorage.removeItem("checkoutData");
          sessionStorage.removeItem("checkoutOffice");
          return;
        default:
          setError(translateError(res.error));
          return;
      }
    } finally {
      setPlacing(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">Преглед на поръчката</h1>

      {/* Progress */}
      <div className="flex items-center gap-2 mb-8 text-sm">
        <span className="text-muted-foreground">1. Данни</span>
        <Separator orientation="horizontal" className="flex-1" />
        <span className="font-semibold text-primary">2. Преглед</span>
        <Separator orientation="horizontal" className="flex-1" />
        <span className="text-muted-foreground">3. Потвърждение</span>
      </div>

      <div className="space-y-6">
        {/* Customer info */}
        <div className="rounded-lg border border-border p-4">
          <h2 className="font-semibold mb-3">Лични данни</h2>
          <div className="grid grid-cols-2 gap-y-1 text-sm">
            <span className="text-muted-foreground">Имена:</span>
            <span>{formData.firstName} {formData.lastName}</span>
            <span className="text-muted-foreground">Email:</span>
            <span>{formData.email}</span>
            <span className="text-muted-foreground">Телефон:</span>
            <span>{formData.phone}</span>
          </div>
        </div>

        {/* Delivery */}
        <div className="rounded-lg border border-border p-4">
          <h2 className="font-semibold mb-3 flex items-center gap-2">
            {formData.deliveryMethod === "courier" ? <Truck className="w-4 h-4" /> : <Store className="w-4 h-4" />}
            {deliveryLabels[formData.deliveryMethod]}
          </h2>
          {formData.deliveryMethod === "courier" && (
            <div className="text-sm space-y-1">
              {formData.courierCompany && (
                <p className="text-muted-foreground">Куриер: {courierLabels[formData.courierCompany] ?? formData.courierCompany}</p>
              )}
              {formData.deliveryType === "to_address" && formData.address && (
                <p>{formData.address.street}, {formData.address.city} {formData.address.postalCode}</p>
              )}
              {formData.deliveryType === "to_office" && formData.officeId && (() => {
                const office = getOfficeById(formData.officeId!);
                return office ? (
                  <p>{office.name} — {office.address}</p>
                ) : null;
              })()}
            </div>
          )}
          {formData.deliveryMethod === "pickup" && (
            <p className="text-sm text-muted-foreground">Ще получите имейл с готовността на поръчката.</p>
          )}
        </div>

        {/* Payment */}
        <div className="rounded-lg border border-border p-4">
          <h2 className="font-semibold mb-1 flex items-center gap-2">
            <Banknote className="w-4 h-4" />
            {paymentLabels[formData.paymentMethod] ?? formData.paymentMethod}
          </h2>
        </div>

        {/* Items */}
        <div className="rounded-lg border border-border p-4">
          <h2 className="font-semibold mb-3">Продукти</h2>
          <div className="space-y-3">
            {items.map((item) => (
              <div key={item.productId} className="flex items-center gap-3">
                <div className="w-12 h-12 flex-shrink-0 rounded bg-muted overflow-hidden">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={item.image?.url ?? "https://placehold.co/200x200/e2e8f0/94a3b8?text=N/A"}
                    alt={item.image?.alt ?? item.name}
                    className="w-full h-full object-cover"
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{item.name}</p>
                  <p className="text-xs text-muted-foreground">{item.code}</p>
                </div>
                <div className="text-right text-sm">
                  <p className="font-semibold">{formatCents(item.priceCents * item.quantity)}</p>
                  <p className="text-muted-foreground">{item.quantity} бр.</p>
                </div>
              </div>
            ))}
          </div>
          <Separator className="my-3" />
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Сума</span>
              <span>{formatCents(subtotalCents)}</span>
            </div>
            {discountPercent > 0 && (
              <div className="flex justify-between text-green-600">
                <span>Отстъпка ({discountPercent}%)</span>
                <span>- {formatCents(discountAmountCents)}</span>
              </div>
            )}
          </div>
          <Separator className="my-3" />
          <div className="flex justify-between font-bold text-base">
            <span>Общо</span>
            <span className="text-primary">{formatCents(totalCents)}</span>
          </div>
        </div>

        {/* Error banner — same visual language as login / register pages */}
        {error && (
          <p
            role="alert"
            aria-live="polite"
            className="text-sm text-destructive bg-destructive/5 border border-destructive/20 rounded-md p-3"
          >
            {error}
          </p>
        )}

        {/* Actions */}
        <div className="flex flex-col sm:flex-row gap-3">
          <ButtonLink variant="outline" className="gap-2" href="/checkout">
            <ArrowLeft className="w-4 h-4" /> Назад
          </ButtonLink>
          <Button onClick={handleConfirm} disabled={placing} className="flex-1 gap-2 sm:ml-auto">
            <CheckCircle className="w-4 h-4" />
            {placing ? "Изпращане..." : "Потвърди поръчката"}
          </Button>
        </div>
      </div>
    </div>
  );
}
