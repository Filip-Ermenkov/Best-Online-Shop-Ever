"use client";

import { Minus, Plus, Trash2, ShoppingBag, AlertCircle, Loader2 } from "lucide-react";
import { useCart } from "@/contexts/CartContext";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Separator } from "@/components/ui/separator";
import { formatCents } from "@/lib/utils";
import { MAX_QUANTITY_PER_LINE } from "@/lib/cart/types";

interface CartDrawerProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Bulgarian-localised copy for cart errors. Each branch maps a CartError
 * discriminator to a one-liner the user can act on. Short, kind, and never
 * leaks "internal server error" jargon.
 */
function cartErrorCopy(kind: string): string {
  switch (kind) {
    case "out_of_stock":
      return "Продуктът е изчерпан и беше премахнат от наличните.";
    case "not_found":
      return "Този продукт вече не е наличен в каталога.";
    case "unauthenticated":
      return "Сесията Ви е изтекла. Моля, влезте отново.";
    case "network":
      return "Няма връзка със сървъра. Опитайте отново.";
    case "validation":
      return "Невалидно количество. Опитайте отново.";
    default:
      return "Възникна грешка. Моля, опитайте отново.";
  }
}

export default function CartDrawer({ open, onClose }: CartDrawerProps) {
  const {
    items,
    removeItem,
    setQuantity,
    subtotalCents,
    itemCount,
    status,
    lastError,
  } = useCart();

  // TODO(auth slice 2): the public /auth/me endpoint does not yet expose the
  // customer discount. Backend stores it on users.customer_discount_percent
  // and applies it at order creation. Setting to 0 here keeps the UI numbers
  // consistent with what the backend will price the order at.
  const discountPercent = 0;
  const discountAmountCents = Math.round(subtotalCents * (discountPercent / 100));
  const totalCents = subtotalCents - discountAmountCents;

  const isMutating = status === "mutating";
  const isLoading = status === "loading";

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="flex flex-col w-full sm:max-w-md p-0" side="right">
        <SheetHeader className="px-6 py-4 border-b border-border">
          <SheetTitle className="flex items-center gap-2">
            <ShoppingBag className="w-5 h-5" />
            Количка
            {itemCount > 0 && (
              <span className="text-sm font-normal text-muted-foreground">({itemCount} продукта)</span>
            )}
            {(isMutating || isLoading) && (
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" aria-label="Зарежда" />
            )}
          </SheetTitle>
        </SheetHeader>

        {lastError && (
          <div
            role="alert"
            className="mx-6 mt-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden="true" />
            <span>{cartErrorCopy(lastError.kind)}</span>
          </div>
        )}

        {items.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6 py-12 text-center">
            <ShoppingBag className="w-12 h-12 text-muted-foreground/40" />
            <div>
              <p className="font-medium">Количката е празна</p>
              <p className="text-sm text-muted-foreground mt-1">Добавете продукти, за да продължите</p>
            </div>
            <ButtonLink variant="outline" href="/products" onClick={onClose}>Разгледай продукти</ButtonLink>
          </div>
        ) : (
          <>
            {/* Items */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              {items.map((item) => {
                const isOos = item.stockStatus === "out_of_stock";
                return (
                  <div key={item.productId} className="flex gap-3">
                    <div className="w-16 h-16 flex-shrink-0 rounded-md bg-muted overflow-hidden relative">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={item.image?.url ?? "https://placehold.co/200x200/e2e8f0/94a3b8?text=N/A"}
                        alt={item.image?.alt ?? item.name}
                        className="w-full h-full object-cover"
                      />
                      {isOos && (
                        <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                          <span className="text-[10px] font-semibold text-white text-center px-1 leading-tight">Изчерпано</span>
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm font-medium leading-tight line-clamp-2 ${isOos ? "text-muted-foreground line-through" : ""}`}>
                        {item.name}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">{item.code}</p>
                      <p className={`text-sm font-semibold mt-1 ${isOos ? "text-muted-foreground" : "text-primary-strong"}`}>
                        {formatCents(item.priceCents)}
                      </p>
                      {isOos && (
                        <p className="text-xs text-destructive mt-0.5">
                          Не може да се поръча
                        </p>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-2 flex-shrink-0">
                      <button
                        onClick={() => removeItem(item.productId)}
                        className="text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
                        aria-label="Премахни"
                        disabled={isMutating}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                      <div className="flex items-center gap-1 border border-border rounded-md">
                        <button
                          onClick={() => setQuantity(item.productId, item.quantity - 1)}
                          className="w-7 h-7 flex items-center justify-center hover:bg-muted transition-colors rounded-l-md disabled:opacity-50"
                          aria-label="Намали"
                          disabled={isMutating}
                        >
                          <Minus className="w-3 h-3" />
                        </button>
                        <span className="w-7 text-center text-sm">{item.quantity}</span>
                        <button
                          onClick={() => setQuantity(item.productId, item.quantity + 1)}
                          className="w-7 h-7 flex items-center justify-center hover:bg-muted transition-colors rounded-r-md disabled:opacity-50"
                          aria-label="Увеличи"
                          disabled={isMutating || item.quantity >= MAX_QUANTITY_PER_LINE || isOos}
                        >
                          <Plus className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Totals + CTA */}
            <div className="border-t border-border px-6 py-4 space-y-3">
              <div className="space-y-1.5 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Сума</span>
                  <span>{formatCents(subtotalCents)}</span>
                </div>
                {discountPercent > 0 && (
                  <div className="flex justify-between text-green-700">
                    <span>Отстъпка ({discountPercent}%)</span>
                    <span>- {formatCents(discountAmountCents)}</span>
                  </div>
                )}
              </div>
              <Separator />
              <div className="flex justify-between font-semibold">
                <span>Общо</span>
                <span className="text-primary-strong text-base">{formatCents(totalCents)}</span>
              </div>
              <ButtonLink
                className="w-full"
                size="lg"
                href="/checkout"
                onClick={onClose}
              >
                Продължи към поръчка
              </ButtonLink>
              <Button variant="outline" className="w-full" onClick={onClose}>
                Продължи пазаруването
              </Button>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
