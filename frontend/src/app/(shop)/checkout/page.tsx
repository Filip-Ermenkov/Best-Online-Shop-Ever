"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useCart } from "@/contexts/CartContext";
import { useAuth } from "@/contexts/AuthContext";
import { CheckoutFormData } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { formatPrice, cn } from "@/lib/utils";
import { ShoppingBag, Truck, Store, Banknote, MapPin, Search } from "lucide-react";
import { getOfficesByCompany, CourierOffice } from "@/lib/mock-data/courier-offices";

function RadioOption({
  value, selected, onChange, label, description, icon: Icon
}: {
  value: string; selected: boolean; onChange: (v: string) => void;
  label: string; description: string; icon: React.ElementType;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(value)}
      className={cn(
        "w-full flex items-start gap-3 p-3 rounded-lg border-2 text-left transition-colors",
        selected ? "border-primary bg-primary/5" : "border-border hover:border-muted-foreground"
      )}
    >
      <Icon className="w-5 h-5 mt-0.5 flex-shrink-0 text-primary" />
      <div>
        <p className="font-medium text-sm">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </button>
  );
}

export default function CheckoutPage() {
  const router = useRouter();
  const { items, subtotal, itemCount } = useCart();
  const { user } = useAuth();

  const [form, setForm] = useState<CheckoutFormData>({
    firstName: user?.firstName ?? "",
    lastName: user?.lastName ?? "",
    email: user?.email ?? "",
    phone: "",
    deliveryMethod: "courier",
    paymentMethod: "cash_on_delivery",
    courierCompany: "econt",
    deliveryType: "to_address",
    address: { street: "", city: "", postalCode: "", country: "България" },
  });

  const [officeSearch, setOfficeSearch] = useState("");
  const [selectedOffice, setSelectedOffice] = useState<CourierOffice | null>(null);

  // TODO(auth slice 2): the public /auth/me endpoint does not yet expose
  // the customer discount. Backend stores it on users.customer_discount_percent
  // and applies it at order creation. Setting to 0 here keeps the UI numbers
  // consistent with what the backend will price the order at.
  const discountPercent = 0;
  const discountAmount = subtotal * (discountPercent / 100);
  const total = subtotal - discountAmount;

  const offices = form.courierCompany
    ? getOfficesByCompany(form.courierCompany).filter((o) =>
        officeSearch.trim().length === 0 ||
        o.city.toLowerCase().includes(officeSearch.toLowerCase()) ||
        o.name.toLowerCase().includes(officeSearch.toLowerCase()) ||
        o.address.toLowerCase().includes(officeSearch.toLowerCase())
      )
    : [];

  if (itemCount === 0) {
    return (
      <div className="max-w-lg mx-auto px-4 py-20 text-center">
        <ShoppingBag className="w-12 h-12 text-muted-foreground/40 mx-auto mb-4" />
        <h1 className="text-xl font-bold mb-2">Количката е празна</h1>
        <p className="text-muted-foreground mb-6">Добавете продукти, за да направите поръчка.</p>
        <ButtonLink href="/products/electronics">Разгледай продукти</ButtonLink>
      </div>
    );
  }

  function setField<K extends keyof CheckoutFormData>(key: K, value: CheckoutFormData[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function handleContinue(e: React.FormEvent) {
    e.preventDefault();
    const data = { ...form, officeId: selectedOffice?.id };
    sessionStorage.setItem("checkoutData", JSON.stringify(data));
    sessionStorage.setItem("checkoutOffice", JSON.stringify(selectedOffice));
    router.push("/checkout/review");
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">Оформяне на поръчка</h1>

      {/* Progress */}
      <div className="flex items-center gap-2 mb-8 text-sm">
        <span className="font-semibold text-primary">1. Данни</span>
        <Separator orientation="horizontal" className="flex-1" />
        <span className="text-muted-foreground">2. Преглед</span>
        <Separator orientation="horizontal" className="flex-1" />
        <span className="text-muted-foreground">3. Потвърждение</span>
      </div>

      <form onSubmit={handleContinue} className="grid md:grid-cols-[1fr_340px] gap-8">
        {/* Left: Form */}
        <div className="space-y-6">
          {/* Personal info */}
          <section>
            <h2 className="font-semibold mb-3">Лични данни</h2>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="firstName">Име</Label>
                <Input id="firstName" value={form.firstName} onChange={(e) => setField("firstName", e.target.value)} required className="mt-1" />
              </div>
              <div>
                <Label htmlFor="lastName">Фамилия</Label>
                <Input id="lastName" value={form.lastName} onChange={(e) => setField("lastName", e.target.value)} required className="mt-1" />
              </div>
              <div>
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" value={form.email} onChange={(e) => setField("email", e.target.value)} required className="mt-1" />
              </div>
              <div>
                <Label htmlFor="phone">Телефон</Label>
                <Input id="phone" type="tel" value={form.phone} onChange={(e) => setField("phone", e.target.value)} required className="mt-1" placeholder="+359 88 ..." />
              </div>
            </div>
          </section>

          <Separator />

          {/* Delivery method */}
          <section>
            <h2 className="font-semibold mb-3">Начин на доставка</h2>
            <div className="grid grid-cols-2 gap-3">
              <RadioOption
                value="courier" selected={form.deliveryMethod === "courier"}
                onChange={(v) => setField("deliveryMethod", v as "courier")}
                label="Куриер" description="Доставка до адрес или офис" icon={Truck}
              />
              <RadioOption
                value="pickup" selected={form.deliveryMethod === "pickup"}
                onChange={(v) => setField("deliveryMethod", v as "pickup")}
                label="От магазина" description="Вземи лично" icon={Store}
              />
            </div>

            {form.deliveryMethod === "courier" && (
              <div className="mt-4 space-y-4">
                {/* Courier company */}
                <div>
                  <p className="text-sm font-medium mb-2">Куриерска фирма</p>
                  <div className="grid grid-cols-2 gap-3">
                    <RadioOption
                      value="econt" selected={form.courierCompany === "econt"}
                      onChange={(v) => { setField("courierCompany", v as "econt"); setSelectedOffice(null); }}
                      label="Еконт" description="econt.bg" icon={Truck}
                    />
                    <RadioOption
                      value="speedy" selected={form.courierCompany === "speedy"}
                      onChange={(v) => { setField("courierCompany", v as "speedy"); setSelectedOffice(null); }}
                      label="Спиди" description="speedy.bg" icon={Truck}
                    />
                  </div>
                </div>

                {/* Delivery type */}
                <div>
                  <p className="text-sm font-medium mb-2">Начин на получаване</p>
                  <div className="grid grid-cols-2 gap-3">
                    <RadioOption
                      value="to_address" selected={form.deliveryType === "to_address"}
                      onChange={(v) => { setField("deliveryType", v as "to_address"); setSelectedOffice(null); }}
                      label="До адрес" description="Доставка на посочен адрес" icon={MapPin}
                    />
                    <RadioOption
                      value="to_office" selected={form.deliveryType === "to_office"}
                      onChange={(v) => setField("deliveryType", v as "to_office")}
                      label="До офис" description="Вземане от офис на куриер" icon={Store}
                    />
                  </div>
                </div>

                {/* Address fields */}
                {form.deliveryType === "to_address" && (
                  <div className="space-y-3">
                    <div>
                      <Label htmlFor="street">Адрес</Label>
                      <Input id="street" value={form.address?.street ?? ""} onChange={(e) => setField("address", { ...form.address!, street: e.target.value })} required className="mt-1" placeholder="ул. / бул. / ж.к." />
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                      <div className="col-span-2">
                        <Label htmlFor="city">Град</Label>
                        <Input id="city" value={form.address?.city ?? ""} onChange={(e) => setField("address", { ...form.address!, city: e.target.value })} required className="mt-1" />
                      </div>
                      <div>
                        <Label htmlFor="postalCode">Пощенски код</Label>
                        <Input id="postalCode" value={form.address?.postalCode ?? ""} onChange={(e) => setField("address", { ...form.address!, postalCode: e.target.value })} required className="mt-1" />
                      </div>
                    </div>
                  </div>
                )}

                {/* Office selector */}
                {form.deliveryType === "to_office" && (
                  <div className="space-y-2">
                    <Label>Офис на {form.courierCompany === "econt" ? "Еконт" : "Спиди"}</Label>
                    <div className="relative mt-1">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input
                        placeholder="Търси по град или адрес..."
                        value={officeSearch}
                        onChange={(e) => setOfficeSearch(e.target.value)}
                        className="pl-9"
                      />
                    </div>
                    <div className="border border-border rounded-md max-h-48 overflow-y-auto divide-y divide-border">
                      {offices.length === 0 ? (
                        <p className="text-sm text-muted-foreground p-3">Няма намерени офиси.</p>
                      ) : (
                        offices.map((office) => (
                          <button
                            key={office.id}
                            type="button"
                            onClick={() => setSelectedOffice(office)}
                            className={cn(
                              "w-full text-left px-3 py-2.5 text-sm transition-colors hover:bg-muted",
                              selectedOffice?.id === office.id && "bg-primary/5 text-primary font-medium"
                            )}
                          >
                            <p className="font-medium">{office.name} — {office.city}</p>
                            <p className="text-xs text-muted-foreground mt-0.5">{office.address}</p>
                          </button>
                        ))
                      )}
                    </div>
                    {!selectedOffice && (
                      <p className="text-xs text-destructive">Моля, изберете офис.</p>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>

          <Separator />

          {/* Payment */}
          <section>
            <h2 className="font-semibold mb-3">Начин на плащане</h2>
            <div className="grid grid-cols-2 gap-3">
              <RadioOption
                value="cash_on_delivery" selected={form.paymentMethod === "cash_on_delivery"}
                onChange={(v) => setField("paymentMethod", v as "cash_on_delivery")}
                label="Наложен платеж" description="Плащате при доставка" icon={Banknote}
              />
              <RadioOption
                value="pay_at_store" selected={form.paymentMethod === "pay_at_store"}
                onChange={(v) => setField("paymentMethod", v as "pay_at_store")}
                label="Плащане на място" description="При вземане от магазина" icon={Store}
              />
            </div>
          </section>
        </div>

        {/* Right: Order summary */}
        <div className="space-y-4">
          <div className="rounded-lg border border-border p-4 space-y-3">
            <h2 className="font-semibold">Вашата поръчка</h2>
            <div className="space-y-2 max-h-52 overflow-y-auto">
              {items.map((item) => (
                <div key={item.productId} className="flex justify-between gap-2 text-sm">
                  <span className="truncate text-muted-foreground">{item.name} × {item.quantity}</span>
                  <span className="flex-shrink-0 font-medium">{formatPrice(item.price * item.quantity)}</span>
                </div>
              ))}
            </div>
            <Separator />
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
            <Separator />
            <div className="flex justify-between font-bold">
              <span>Общо</span>
              <span className="text-primary">{formatPrice(total)}</span>
            </div>
          </div>
          <Button
            type="submit"
            className="w-full"
            size="lg"
            disabled={form.deliveryMethod === "courier" && form.deliveryType === "to_office" && !selectedOffice}
          >
            Продължи към преглед
          </Button>
        </div>
      </form>
    </div>
  );
}
