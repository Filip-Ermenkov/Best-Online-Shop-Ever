"use client";

import Link from "next/link";
import { useState } from "react";
import { ShoppingCart, Minus, Plus } from "lucide-react";
import { Product } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCart } from "@/contexts/CartContext";
import { MAX_QUANTITY_PER_LINE } from "@/lib/cart/types";
import { formatPrice, cn } from "@/lib/utils";

interface ProductCardProps {
  product: Product;
  /**
   * Optional canonical URL for this product. When passed, the card links
   * here directly. When omitted, the card links to the short
   * `/products/{slug}` form — which the catch-all route resolves and 301s
   * to the canonical category-prefixed URL. Pages that already know the
   * category chain (category listing, search-result list with breadcrumb
   * lookup) should pass the full URL to skip the redirect hop; pages that
   * don't (home featured grid) just omit it.
   */
  href?: string;
  className?: string;
}

export default function ProductCard({ product, href, className }: ProductCardProps) {
  const { addGuestItem, addItem, isAuthenticated } = useCart();
  const [quantity, setQuantity] = useState(1);
  const [added, setAdded] = useState(false);
  const isOutOfStock = product.stockStatus === "out_of_stock";

  const productUrl = href ?? `/products/${product.slug}`;

  const handleAddToCart = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isOutOfStock) return;
    // The card can serve both anonymous (use addGuestItem with snapshot) and
    // authenticated (server hydrates everything from productId) users.
    if (isAuthenticated) {
      void addItem(product.id, quantity);
    } else {
      addGuestItem({
        productId: product.id,
        quantity,
        snapshot: {
          slug: product.slug,
          code: product.code,
          name: product.name,
          // mock data is in EUR (decimal); convert to cents for the cart wire shape
          priceCents: Math.round(product.price * 100),
          currency: product.currency,
          stockStatus: product.stockStatus,
          image: product.images[0]
            ? { url: product.images[0].url, alt: product.images[0].alt }
            : null,
        },
      });
    }
    setAdded(true);
    setTimeout(() => setAdded(false), 1800);
  };

  const handleQuantityChange = (delta: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // The DB does not track stock quantity (only stockStatus). Cap at the
    // server's per-line ceiling so the stepper can't suggest a value the
    // server will clamp anyway.
    setQuantity((q) => Math.min(Math.max(1, q + delta), MAX_QUANTITY_PER_LINE));
  };

  return (
    <Link
      href={productUrl}
      className={cn(
        "group relative flex flex-col rounded-lg border border-border bg-card card-lift overflow-hidden",
        className
      )}
    >
      {/* New badge */}
      {product.isNew && (
        <div className="absolute top-2 left-2 z-10">
          <Badge className="bg-[oklch(0.73_0.10_75)] text-[oklch(0.18_0.02_270)] text-[10px] px-1.5 py-0.5 font-semibold">НОВО</Badge>
        </div>
      )}

      {/* Image */}
      <div className={cn("aspect-square bg-muted relative overflow-hidden", isOutOfStock && "opacity-50")}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={product.images[0]?.url ?? "https://placehold.co/400x400/e2e8f0/94a3b8?text=No+Image"}
          alt={product.images[0]?.alt ?? product.name}
          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
        />
        {isOutOfStock && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/20">
            <span className="text-xs font-semibold text-white bg-black/60 px-2 py-1 rounded">Изчерпано</span>
          </div>
        )}
      </div>

      {/* Info */}
      <div className="flex flex-col flex-1 p-3 gap-1.5">
        <p className="text-xs text-muted-foreground">{product.code}</p>
        <h3 className="text-sm font-medium leading-snug line-clamp-2 flex-1">{product.name}</h3>

        {/* Stock status — only in_stock or out_of_stock */}
        <p className={cn(
          "text-xs",
          product.stockStatus === "in_stock" ? "text-green-600" : "text-muted-foreground"
        )}>
          {product.stockStatus === "in_stock" ? "В наличност" : "Изчерпано"}
        </p>

        {/* Price */}
        <span className="font-bold text-base text-primary">{formatPrice(product.price)}</span>

        {/* Quantity selector + Add to cart — responsive, never cut off */}
        {!isOutOfStock ? (
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 mt-auto" onClick={(e) => e.preventDefault()}>
            <div className="flex items-center border border-border rounded-md self-start">
              <button
                onClick={(e) => handleQuantityChange(-1, e)}
                className="w-7 h-7 flex items-center justify-center hover:bg-muted transition-colors rounded-l-md text-muted-foreground hover:text-foreground"
                aria-label="Намали"
              >
                <Minus className="w-3 h-3" />
              </button>
              <span className="w-8 text-center text-sm font-medium">{quantity}</span>
              <button
                onClick={(e) => handleQuantityChange(1, e)}
                className="w-7 h-7 flex items-center justify-center hover:bg-muted transition-colors rounded-r-md text-muted-foreground hover:text-foreground"
                aria-label="Увеличи"
              >
                <Plus className="w-3 h-3" />
              </button>
            </div>
            <Button
              size="sm"
              onClick={handleAddToCart}
              className="w-full sm:flex-1 gap-1 text-xs"
              aria-label={`Добави ${product.name} в количката`}
            >
              <ShoppingCart className="w-3.5 h-3.5" />
              {added ? "✓" : "Добави"}
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="outline" disabled className="w-full mt-auto">
            Изчерпано
          </Button>
        )}
      </div>
    </Link>
  );
}
