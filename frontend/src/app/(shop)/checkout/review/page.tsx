"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useCart } from "@/contexts/CartContext";
import { useAuth } from "@/contexts/AuthContext";
import { CheckoutFormData } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Separator } from "@/components/ui/separator";
import { formatPrice } from "@/lib/utils";
import { CheckCircle, ArrowLeft, Truck, Store, Banknote } from "lucide-react";
import { getOfficeById } from "@/lib/mock-data/courier-offices";

const deliveryLabels = { courier: "Доставка с куриер", pickup: "Вземане от магазин" };
const paymentLabels: Record<string, string> = { cash_on_delivery: "Наложен платеж", pay_at_store: "Плащане на място" };
const courierLabels: Record<string, string> = { econt: "Еконт", speedy: "Спиди" };

export default function CheckoutReviewPage() {
  const router = useRouter();
  const { items, subtotal, clearCart } = useCart();
  const { user } = useAuth();
  const [formData, setFormData] = useState<CheckoutFormData | null>(null);
  const [placing, setPlacing] = useState(false);

  useEffect(() => {
    const saved = sessionStorage.getItem("checkoutData");
    if (!saved) { router.replace("/checkout"); return; }
    setFormData(JSON.parse(saved));
  }, [router]);

  const discountPercent = user?.discountPercent ?? 0;
  const discountAmount = subtotal * (discountPercent / 100);
  const total = subtotal - discountAmount;

  if (!formData) return null;

  async function handleConfirm() {
    setPlacing(true);
    // Simulate API call
    await new Promise((r) => setTimeout(r, 1200));
    const orderId = `ORD-2026-${String(Date.now()).slice(-4)}`;
    clearCart();
    sessionStorage.removeItem("checkoutData");
    router.push(`/checkout/confirmation?orderId=${orderId}`);
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
                  <img src={item.imageUrl} alt={item.name} className="w-full h-full object-cover" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{item.name}</p>
                  <p className="text-xs text-muted-foreground">{item.code}</p>
                </div>
                <div className="text-right text-sm">
                  <p className="font-semibold">{formatPrice(item.price * item.quantity)}</p>
                  <p className="text-muted-foreground">{item.quantity} бр.</p>
                </div>
              </div>
            ))}
          </div>
          <Separator className="my-3" />
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Сума</span>
              <span>{formatPrice(subtotal)}</span>
            </div>
            {discountPercent > 0 && (
              <div className="flex justify-between text-green-600">
                <span>Отстъпка ({discountPercent}%)</span>
                <span>- {formatPrice(discountAmount)}</span>
              </div>
            )}
          </div>
          <Separator className="my-3" />
          <div className="flex justify-between font-bold text-base">
            <span>Общо</span>
            <span className="text-primary">{formatPrice(total)}</span>
          </div>
        </div>

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
