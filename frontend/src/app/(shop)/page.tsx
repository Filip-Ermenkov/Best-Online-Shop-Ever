import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { fetchBanners, fetchCategoryTree, fetchProducts } from "@/lib/api";
import type { Banner, Product } from "@/lib/types";
import ProductCard from "@/components/shop/ProductCard";
import BannerSlider from "@/components/shop/BannerSlider";
import AccountDeletedBanner from "@/components/shop/AccountDeletedBanner";
import { ButtonLink } from "@/components/ui/button-link";

/**
 * Home page is a Server Component — both categories and featured products
 * fetch on the server, are cached by Next.js for 5 minutes (matching the API's
 * Cache-Control), and the rendered HTML ships fully populated.
 *
 * Banners now come from the live `/banners` API (the admin manages them at
 * /admin/banners). They're non-essential decoration, so a banner-fetch failure
 * degrades to "no hero" rather than failing the whole page — unlike categories
 * and products, whose failure surfaces the nearest error.tsx.
 *
 * Error / empty handling: if the API is reachable but returns nothing, the
 * grid renders empty (no error UI shown). If the API is unreachable, the
 * fetch helper throws ApiClientError; Next.js renders the nearest error.tsx.
 */
export default async function HomePage() {
  // Fetch in parallel — none depends on the others. Banners degrade to an empty
  // hero on failure (decoration, not core content).
  const [categoryTree, productsPage, bannerData] = await Promise.all([
    fetchCategoryTree(),
    fetchProducts({ sort: "featured", limit: 8 }),
    fetchBanners().catch(
      () => ({ items: [] }) as Awaited<ReturnType<typeof fetchBanners>>,
    ),
  ]);

  // Only show ROOT categories on the home grid. Subcategory navigation lives
  // in the header dropdown (later slice).
  const rootCategories = categoryTree.items;
  const featuredProducts = productsPage.items.map(adaptApiProductToFrontend);
  const heroBanners = bannerData.items.map(adaptApiBannerToFrontend);

  return (
    <div>
      {/* Post-deletion success banner — only renders when the URL carries
         ?account-deleted=success. Lightweight client island so the rest
         of the page stays statically rendered. */}
      <AccountDeletedBanner />

      {/* Banner Slider — live data from /banners (admin-managed). Renders
         nothing when there are no active slides. */}
      <BannerSlider banners={heroBanners} />

      {/* Categories grid — image cards, same size as product cards */}
      <section className="max-w-7xl mx-auto px-4 py-10">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-xl font-bold">Категории</h2>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {rootCategories.map((cat) => (
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
          {rootCategories[0] && (
            // Land on the first root category — a "Всички продукти" landing
            // page that lists all roots is its own slice. Linking to a real
            // category is fine because the destination renders its own
            // subcategory grid anyway.
            <ButtonLink
              variant="ghost"
              size="sm"
              href={`/products/${rootCategories[0].slug}`}
              className="gap-1.5"
            >
              Всички продукти <ArrowRight className="w-4 h-4" />
            </ButtonLink>
          )}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {featuredProducts.map((p) => (
            // Pass the short form `/products/{slug}` — the catch-all route's
            // single-segment fallback permanently-redirects to the canonical
            // category-prefixed URL. Featured products span multiple
            // categories so the home page can't pre-compute the breadcrumb
            // chain cheaply (would need an N+1 fetch per product).
            <ProductCard key={p.id} product={p} href={`/products/${p.slug}`} />
          ))}
        </div>
      </section>
    </div>
  );
}

// ─── Adapter ───────────────────────────────────────────────────────────────

/**
 * The API returns prices as integer cents and images as a flat list with
 * displayOrder. ProductCard (a pre-existing Client Component) expects the
 * frontend's local `Product` shape with `price` in EUR and a different image
 * type. Convert at the page boundary so neither side has to know about the
 * other.
 *
 * This adapter will disappear when the frontend's local types are replaced
 * with `InferResponseType<typeof api.products.$get>` and the existing
 * components refactored — that's a separate slice.
 */
type ApiBannerSlide = Awaited<ReturnType<typeof fetchBanners>>["items"][number];

/**
 * Map the API banner shape (nullable text, S3-derived `imageUrl`,
 * `displayOrder`) onto the slider's local `Banner` prop type. Every slide the
 * `/banners` endpoint returns is active by construction, so `isActive` is true;
 * the CTA label defaults to a generic „Разгледай" when a link is present (the
 * schema carries no per-slide label — kept spec-minimal).
 */
function adaptApiBannerToFrontend(b: ApiBannerSlide): Banner {
  return {
    id: b.id,
    title: b.title ?? "",
    subtitle: b.subtitle ?? undefined,
    imageUrl: b.imageUrl,
    linkUrl: b.linkUrl ?? undefined,
    linkLabel: b.linkUrl ? "Разгледай" : undefined,
    isActive: true,
    order: b.displayOrder,
  };
}

type ApiProductSummary = Awaited<
  ReturnType<typeof fetchProducts>
>["items"][number];

function adaptApiProductToFrontend(p: ApiProductSummary): Product {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    code: p.code,
    description: "", // summary doesn't carry description; not needed on cards
    price: p.priceCents / 100,
    currency: "EUR",
    images: p.primaryImage
      ? [{ id: p.primaryImage.id, url: p.primaryImage.url, alt: p.primaryImage.alt }]
      : [],
    categoryId: "", // root grid doesn't render category-aware product URLs;
    // ProductCard only uses categoryId to build a breadcrumb path, which
    // the home page doesn't need (the link still resolves via /products/{slug}).
    stockStatus: p.stockStatus,
    stockQuantity: p.stockStatus === "in_stock" ? 99 : 0,
    isNew: p.isNew,
    displayOrder: 0,
    createdAt: "",
    updatedAt: "",
    isArchived: false,
  };
}
