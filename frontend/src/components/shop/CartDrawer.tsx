"use client";

import Link from "next/link";
import { Minus, Plus, Trash2, ShoppingBag } from "lucide-react";
import { useCart } from "@/contexts/CartContext";
import { useAuth } from "@/contexts/AuthContext";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Separator } from "@/components/ui/separator";
import { formatPrice } from "@/lib/utils";

interface CartDrawerProps {
  open: boolean;
  onClose: () => void;
}

export default function CartDrawer({ open, onClose }: CartDrawerProps) {
  const { items, removeItem, updateQuantity, subtotal, itemCount } = useCart();
  const { user } = useAuth();

  const discountPercent = user?.discountPercent ?? 0;
  const discountAmount = subtotal * (discountPercent / 100);
  const total = subtotal - discountAmount;

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
          </SheetTitle>
        </SheetHeader>

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
              {items.map((item) => (
                <div key={item.productId} className="flex gap-3">
                  <div className="w-16 h-16 flex-shrink-0 rounded-md bg-muted overflow-hidden">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={item.imageUrl} alt={item.name} className="w-full h-full object-cover" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium leading-tight line-clamp-2">{item.name}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{item.code}</p>
                    <p className="text-sm font-semibold text-primary mt-1">{formatPrice(item.price)}</p>
                  </div>
                  <div className="flex flex-col items-end gap-2 flex-shrink-0">
                    <button
                      onClick={() => removeItem(item.productId)}
                      className="text-muted-foreground hover:text-destructive transition-colors"
                      aria-label="Премахни"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                    <div className="flex items-center gap-1 border border-border rounded-md">
                      <button
                        onClick={() => updateQuantity(item.productId, item.quantity - 1)}
                        className="w-7 h-7 flex items-center justify-center hover:bg-muted transition-colors rounded-l-md"
                        aria-label="Намали"
                      >
                        <Minus className="w-3 h-3" />
                      </button>
                      <span className="w-7 text-center text-sm">{item.quantity}</span>
                      <button
                        onClick={() => updateQuantity(item.productId, item.quantity + 1)}
                        className="w-7 h-7 flex items-center justify-center hover:bg-muted transition-colors rounded-r-md"
                        aria-label="Увеличи"
                      >
                        <Plus className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Totals + CTA */}
            <div className="border-t border-border px-6 py-4 space-y-3">
              <div className="space-y-1.5 text-sm">
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
              <div className="flex justify-between font-semibold">
                <span>Общо</span>
                <span className="text-primary text-base">{formatPrice(total)}</span>
              </div>
              <ButtonLink className="w-full" size="lg" href="/checkout" onClick={onClose}>Продължи към поръчка</ButtonLink>
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
