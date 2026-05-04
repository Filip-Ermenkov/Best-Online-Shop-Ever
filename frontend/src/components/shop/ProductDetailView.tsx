"use client";

import Link from "next/link";
import { useState } from "react";
import { ShoppingCart, Minus, Plus } from "lucide-react";
import { useCart } from "@/contexts/CartContext";
import { MAX_QUANTITY_PER_LINE } from "@/lib/cart/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb, BreadcrumbItem, BreadcrumbLink,
  BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { formatPrice, cn } from "@/lib/utils";
import { Product, CategoryNode } from "@/lib/types";

interface Props {
  product: Product;
  categoryChain: CategoryNode[];
}

export default function ProductDetailView({ product, categoryChain }: Props) {
  const { addGuestItem, addItem, isAuthenticated } = useCart();
  const [quantity, setQuantity] = useState(1);
  const [activeImage, setActiveImage] = useState(0);
  const [added, setAdded] = useState(false);
  // Selected variants are local UI state for now. The current schema does not
  // model variants per cart line — when variant-aware cart lines land they'll
  // get their own (productId, variantId) compound key on cart_items.
  const [selectedVariants, setSelectedVariants] = useState<Record<string, string>>({});

  const isOutOfStock = product.stockStatus === "out_of_stock";

  // When a variant option with an image is selected, show that image
  const variantImages = product.variants?.flatMap((v) =>
    v.options
      .filter((o) => o.imageUrl && selectedVariants[v.id] === o.id)
      .map((o) => ({ id: `variant-${o.id}`, url: o.imageUrl!, alt: `${product.name} – ${o.label}` }))
  ) ?? [];

  const allImages = [...product.images, ...variantImages];

  function selectVariant(variantId: string, optionId: string) {
    setSelectedVariants((prev) => ({ ...prev, [variantId]: optionId }));
    // If this option has an image, switch to it
    const variant = product.variants?.find((v) => v.id === variantId);
    const option = variant?.options.find((o) => o.id === optionId);
    if (option?.imageUrl) {
      const idx = allImages.findIndex((img) => img.url === option.imageUrl);
      if (idx >= 0) setActiveImage(idx);
    }
  }

  function handleAddToCart() {
    if (isOutOfStock) return;
    // Variants are NOT yet propagated to the cart line — see TODO above.
    // Schema work for (productId, variantId) cart key is a separate slice.
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
    setTimeout(() => setAdded(false), 2000);
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      {/* Breadcrumb */}
      <Breadcrumb className="mb-6">
        <BreadcrumbList>
          <BreadcrumbItem><BreadcrumbLink render={<Link href="/" />}>Начало</BreadcrumbLink></BreadcrumbItem>
          {categoryChain.map((cat, i) => {
            const catPath = "/products/" + categoryChain.slice(0, i + 1).map((c) => c.slug).join("/");
            return (
              <span key={cat.id} className="contents">
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbLink render={<Link href={catPath} />}>{cat.name}</BreadcrumbLink>
                </BreadcrumbItem>
              </span>
            );
          })}
          <BreadcrumbSeparator />
          <BreadcrumbItem><BreadcrumbPage>{product.name}</BreadcrumbPage></BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="grid md:grid-cols-2 gap-8 lg:gap-12">
        {/* Images — main image smaller, thumbnails bigger */}
        <div className="space-y-3">
          <div className="aspect-[4/3] max-w-md mx-auto rounded-lg bg-muted overflow-hidden border border-border">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={allImages[activeImage]?.url ?? product.images[0]?.url}
              alt={allImages[activeImage]?.alt ?? product.name}
              className="w-full h-full object-contain"
            />
          </div>
          {allImages.length > 1 && (
            <div className="flex gap-2 flex-wrap justify-center">
              {allImages.map((img, i) => (
                <button
                  key={img.id}
                  onClick={() => setActiveImage(i)}
                  className={cn(
                    "w-20 h-20 sm:w-24 sm:h-24 rounded-md border-2 overflow-hidden transition-colors flex-shrink-0",
                    activeImage === i ? "border-primary ring-2 ring-primary/30" : "border-border hover:border-muted-foreground"
                  )}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={img.url} alt={img.alt} className="w-full h-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Info */}
        <div className="space-y-4">
          {product.isNew && (
            <Badge className="bg-[oklch(0.73_0.10_75)] text-[oklch(0.18_0.02_270)] font-semibold">НОВО</Badge>
          )}

          <div>
            <p className="text-sm text-muted-foreground mb-1">Код: {product.code}</p>
            <h1 className="text-2xl font-bold leading-tight">{product.name}</h1>
          </div>

          {/* Price */}
          <div className="flex items-baseline gap-3">
            <span className="text-3xl font-bold text-primary">{formatPrice(product.price)}</span>
            {product.originalPrice && (
              <span className="text-lg text-muted-foreground line-through">{formatPrice(product.originalPrice)}</span>
            )}
          </div>

          {/* Stock */}
          <p className={cn(
            "text-sm font-medium",
            product.stockStatus === "in_stock" ? "text-green-600" : "text-muted-foreground"
          )}>
            {product.stockStatus === "in_stock" ? "✔ В наличност" : "✖ Изчерпано"}
          </p>

          {/* Variant selectors */}
          {product.variants && product.variants.length > 0 && (
            <div className="space-y-4 pt-1">
              {product.variants.map((variant) => (
                <div key={variant.id}>
                  <p className="text-sm font-semibold mb-2">
                    {variant.name}
                    {selectedVariants[variant.id] && (
                      <span className="font-normal text-muted-foreground ml-2">
                        — {variant.options.find((o) => o.id === selectedVariants[variant.id])?.label}
                      </span>
                    )}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {variant.options.map((opt) => (
                      <button
                        key={opt.id}
                        disabled={!opt.available}
                        onClick={() => selectVariant(variant.id, opt.id)}
                        className={cn(
                          "flex items-center gap-2 px-3 py-1.5 rounded-md text-sm border-2 transition-all",
                          !opt.available && "opacity-40 cursor-not-allowed line-through",
                          opt.available && selectedVariants[variant.id] === opt.id
                            ? "border-primary bg-primary/10 font-medium"
                            : opt.available
                            ? "border-border hover:border-primary/60"
                            : "border-border"
                        )}
                      >
                        {opt.imageUrl && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={opt.imageUrl}
                            alt={opt.label}
                            className="w-6 h-6 rounded-sm object-cover"
                          />
                        )}
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Quantity + Add to cart */}
          {!isOutOfStock && (
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center border border-border rounded-md">
                <button
                  onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                  className="w-10 h-10 flex items-center justify-center hover:bg-muted transition-colors rounded-l-md"
                  aria-label="Намали количество"
                >
                  <Minus className="w-4 h-4" />
                </button>
                <span className="w-12 text-center font-medium">{quantity}</span>
                <button
                  onClick={() => setQuantity((q) => Math.min(MAX_QUANTITY_PER_LINE, q + 1))}
                  className="w-10 h-10 flex items-center justify-center hover:bg-muted transition-colors rounded-r-md"
                  aria-label="Увеличи количество"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>

              <Button size="lg" onClick={handleAddToCart} className="flex-1 min-w-[160px] gap-2">
                <ShoppingCart className="w-5 h-5" />
                {added ? "Добавено!" : "Добави в количката"}
              </Button>
            </div>
          )}

          {isOutOfStock && (
            <Button size="lg" variant="outline" disabled className="w-full">
              Изчерпано
            </Button>
          )}

          {/* Description */}
          <div className="pt-4 border-t border-border">
            <h2 className="font-semibold mb-2">Описание</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">{product.description}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
