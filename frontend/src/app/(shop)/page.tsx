import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { banners } from "@/lib/mock-data/banners";
import { categories, NEW_PRODUCTS_CATEGORY } from "@/lib/mock-data/categories";
import { getFeaturedProducts } from "@/lib/mock-data/products";
import ProductCard from "@/components/shop/ProductCard";
import BannerSlider from "@/components/shop/BannerSlider";
import { ButtonLink } from "@/components/ui/button-link";

export default function HomePage() {
  const featuredProducts = getFeaturedProducts(8);
  const allCategories = [NEW_PRODUCTS_CATEGORY, ...categories];

  return (
    <div>
      {/* Banner Slider */}
      <BannerSlider banners={banners} />

      {/* Categories grid — image cards, same size as product cards */}
      <section className="max-w-7xl mx-auto px-4 py-10">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-xl font-bold">Категории</h2>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {allCategories.map((cat) => (
            <Link
              key={cat.id}
              href={`/products/${cat.slug}`}
              className="group relative rounded-lg border border-border overflow-hidden card-lift bg-card"
            >
              {/* Category image */}
              <div className="aspect-square overflow-hidden bg-muted">
                {cat.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={cat.imageUrl}
                    alt={cat.name}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center bg-[oklch(0.18_0.02_270)] text-[oklch(0.73_0.10_75)] font-bold text-4xl">
                    {cat.name[0]}
                  </div>
                )}
              </div>
              {/* Name overlay */}
              <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-3">
                <p className="text-white font-semibold text-sm leading-tight">{cat.name}</p>
                <p className="text-white/70 text-xs mt-0.5 flex items-center gap-1">
                  Разгледай <ArrowRight className="w-3 h-3" />
                </p>
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* Featured Products */}
      <section className="max-w-7xl mx-auto px-4 pb-14">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-xl font-bold">Препоръчани продукти</h2>
          <ButtonLink variant="ghost" size="sm" href="/products/electronics" className="gap-1.5">
            Всички продукти <ArrowRight className="w-4 h-4" />
          </ButtonLink>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {featuredProducts.map((p) => (
            <ProductCard key={p.id} product={p} />
          ))}
        </div>
      </section>
    </div>
  );
}
