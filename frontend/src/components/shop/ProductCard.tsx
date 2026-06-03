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

/**
 * Accessibility note — the "stretched link" pattern.
 *
 * The card used to be a single <Link> wrapping the whole thing, INCLUDING the
 * quantity stepper and the Add-to-cart <button>s. Nesting interactive controls
 * inside an <a> is invalid HTML (an anchor may not contain interactive content)
 * and produces a broken keyboard/screen-reader experience: the buttons land
 * inside the link, focus order is muddled, and a stray `onClick preventDefault`
 * hack was needed to stop button clicks from navigating.
 *
 * Now the card is a non-interactive <article>. Only the product TITLE is a
 * link, and its `::after` is stretched over the whole card so the entire
 * surface stays clickable for pointer users (WCAG 2.5.8 large target) while
 * exactly one link sits in the tab order with an accessible name (the product
 * name). The action buttons are SIBLINGS of the link, raised above the
 * stretched overlay with `relative z-10`, so they're independently focusable
 * and clickable. Valid HTML, clean focus order, no preventDefault hack.
 */
export default function ProductCard({ product, href, className }: ProductCardProps) {
  const { addGuestItem, addItem, isAuthenticated } = useCart();
  const [quantity, setQuantity] = useState(1);
  const [added, setAdded] = useState(false);
  const isOutOfStock = product.stockStatus === "out_of_stock";

  const productUrl = href ?? `/products/${product.slug}`;

  const handleAddToCart = () => {
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

  const handleQuantityChange = (delta: number) => {
    // The DB does not track stock quantity (only stockStatus). Cap at the
    // server's per-line ceiling so the stepper can't suggest a value the
    // server will clamp anyway.
    setQuantity((q) => Math.min(Math.max(1, q + delta), MAX_QUANTITY_PER_LINE));
  };

  return (
    <article
      className={cn(
        "group relative flex flex-col rounded-lg border border-border bg-card card-lift overflow-hidden",
        className
      )}
    >
      {/* New badge — z-20 keeps it above the stretched product-link overlay */}
      {product.isNew && (
        <div className="absolute top-2 left-2 z-20">
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
        <h3 className="text-sm font-medium leading-snug line-clamp-2 flex-1">
          {/* Stretched link: `after:inset-0` covers the whole card (the
              <article> is the nearest positioned ancestor) so pointer users can
              click anywhere, while only this one link is keyboard-tabbable. */}
          <Link
            href={productUrl}
            className="after:absolute after:inset-0 after:content-[''] hover:text-primary-strong transition-colors"
          >
            {product.name}
          </Link>
        </h3>

        {/* Stock status — only in_stock or out_of_stock */}
        <p className={cn(
          "text-xs",
          product.stockStatus === "in_stock" ? "text-green-700" : "text-muted-foreground"
        )}>
          {product.stockStatus === "in_stock" ? "В наличност" : "Изчерпано"}
        </p>

        {/* Price */}
        <span className="font-bold text-base text-primary-strong">{formatPrice(product.price)}</span>

        {/* Quantity selector + Add to cart. `relative z-10` lifts these above
            the stretched link's overlay so they remain independently
            operable; no preventDefault hack needed any more. */}
        {!isOutOfStock ? (
          <div className="relative z-10 flex flex-col sm:flex-row items-stretch sm:items-center gap-2 mt-auto">
            <div className="flex items-center border border-border rounded-md self-start">
              <button
                type="button"
                onClick={() => handleQuantityChange(-1)}
                className="w-7 h-7 flex items-center justify-center hover:bg-muted transition-colors rounded-l-md text-muted-foreground hover:text-foreground"
                aria-label="Намали количеството"
              >
                <Minus className="w-3 h-3" aria-hidden="true" />
              </button>
              <span className="w-8 text-center text-sm font-medium" aria-live="polite" aria-label={`Количество: ${quantity}`}>{quantity}</span>
              <button
                type="button"
                onClick={() => handleQuantityChange(1)}
                className="w-7 h-7 flex items-center justify-center hover:bg-muted transition-colors rounded-r-md text-muted-foreground hover:text-foreground"
                aria-label="Увеличи количеството"
              >
                <Plus className="w-3 h-3" aria-hidden="true" />
              </button>
            </div>
            <Button
              size="sm"
              onClick={handleAddToCart}
              className="w-full sm:flex-1 gap-1 text-xs"
              aria-label={`Добави ${product.name} в количката`}
            >
              <ShoppingCart className="w-3.5 h-3.5" aria-hidden="true" />
              {added ? "✓" : "Добави"}
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="outline" disabled className="relative z-10 w-full mt-auto">
            Изчерпано
          </Button>
        )}
      </div>
    </article>
  );
}
