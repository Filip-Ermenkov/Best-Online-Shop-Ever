import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { ArrowRight, SlidersHorizontal } from "lucide-react";
import type { Metadata } from "next";
import {
  fetchCategoryTree,
  fetchProductBySlug,
  fetchProducts,
} from "@/lib/api";
import {
  type CategoryTreeNode,
  resolveCategoryPath,
  productHref,
} from "@/lib/catalog";
import type { Product, CategoryNode } from "@/lib/types";
import ProductCard from "@/components/shop/ProductCard";
import ProductFilters from "@/components/shop/ProductFilters";
import MobileFiltersDrawer from "@/components/shop/MobileFiltersDrawer";
import ProductDetailView from "@/components/shop/ProductDetailView";
import {
  Breadcrumb, BreadcrumbItem, BreadcrumbLink,
  BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

/**
 * Storefront catch-all: `/products/[...path]`.
 *
 * Resolves a slug-separated URL path against the live category tree from
 * `GET /categories` and the product catalog from `GET /products`. Four
 * shapes are handled:
 *
 *   1. `/products/new-products` — virtual category, lists newest products.
 *   2. `/products/<cat>/<sub>/...` — pure category chain (every segment
 *      matches a category at the right depth). Renders the category page
 *      with subcategory grid + paginated product list.
 *   3. `/products/<cat>/<sub>/.../<product-slug>` — category chain plus a
 *      trailing product slug. Renders the product detail page.
 *   4. `/products/<product-slug>` — a single non-category segment. Resolves
 *      against the API's `GET /products/{slug}`; if it's a product, 301s to
 *      the canonical category-prefixed URL so the SEO story stays clean
 *      (one canonical URL per product).
 *
 * This is a **Server Component**. The previous revision was a Client
 * Component because it called `use(params)`, but Next.js 16 supports
 * `await params` natively in async Server Components. Server-side rendering
 * here gets us:
 *   - first paint with the matched data already embedded,
 *   - server-side `generateMetadata()` for product pages so social previews
 *     and search engines see real titles + canonical URLs,
 *   - server-side JSON-LD Product / BreadcrumbList structured data per
 *     Google's 2026 schema guidance.
 *
 * The two surviving interactive concerns — sort filters and the
 * mobile-filters drawer — are pushed down into Client Components that take
 * the current `activeSort` as a prop and update the URL when the user picks
 * a different option.
 */

// ─── Sort key mapping ───────────────────────────────────────────────────────

/**
 * The UI's `sort` URL param uses friendly values (`default`, `newest`,
 * `price_asc`, `price_desc`). The API's `sort` query param uses
 * `featured` for the default. Translate at the page boundary and ignore
 * anything we don't recognise (a `featured` default is the safest fallback).
 *
 * Source of truth for the API side:
 *   `backend/shop-api/src/routes/products.ts` `SortKey`.
 */
type ApiSort = "featured" | "newest" | "price_asc" | "price_desc";

function uiSortToApi(ui: string | undefined): ApiSort {
  switch (ui) {
    case "newest":
      return "newest";
    case "price_asc":
      return "price_asc";
    case "price_desc":
      return "price_desc";
    case "default":
    case undefined:
    default:
      return "featured";
  }
}

// ─── Type wrangling ─────────────────────────────────────────────────────────

type ApiProductSummary = Awaited<
  ReturnType<typeof fetchProducts>
>["items"][number];

type ApiProductDetail = NonNullable<
  Awaited<ReturnType<typeof fetchProductBySlug>>
>;

/**
 * Same adapter pattern used elsewhere — the existing `ProductCard` and
 * `ProductDetailView` components are typed against the frontend's local
 * `Product` shape. Adapting at page boundaries keeps the diff small;
 * a follow-up slice can replace the local type entirely with
 * `InferResponseType` from the Hono RPC client.
 */
function adaptSummary(p: ApiProductSummary): Product {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    code: p.code,
    description: "",
    price: p.priceCents / 100,
    currency: "EUR",
    images: p.primaryImage
      ? [{ id: p.primaryImage.id, url: p.primaryImage.url, alt: p.primaryImage.alt }]
      : [],
    categoryId: "",
    stockStatus: p.stockStatus,
    stockQuantity: p.stockStatus === "in_stock" ? 99 : 0,
    isNew: p.isNew,
    displayOrder: 0,
    createdAt: "",
    updatedAt: "",
    isArchived: false,
  };
}

function adaptDetail(p: ApiProductDetail): Product {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    code: p.code,
    description: p.description,
    price: p.priceCents / 100,
    currency: "EUR",
    images: p.images.map((img) => ({ id: img.id, url: img.url, alt: img.alt })),
    categoryId: p.breadcrumb[p.breadcrumb.length - 1]?.id ?? "",
    stockStatus: p.stockStatus,
    stockQuantity: p.stockStatus === "in_stock" ? 99 : 0,
    isNew: p.isNew,
    displayOrder: 0,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    isArchived: false,
  };
}

/**
 * Map the API's breadcrumb (flat list of {id, slug, name}) onto the local
 * `CategoryNode` shape that ProductDetailView's breadcrumb renderer reads.
 * We only need the fields it actually consumes — `id`, `slug`, `name` — but
 * the type wants the whole shape, so we synthesise reasonable defaults for
 * the rest.
 */
function breadcrumbToCategoryChain(
  breadcrumb: ApiProductDetail["breadcrumb"],
): CategoryNode[] {
  return breadcrumb.map((b) => ({
    id: b.id,
    slug: b.slug,
    name: b.name,
    parentId: null,
    children: [],
    order: 0,
    isArchived: false,
  }));
}

// ─── Page props ─────────────────────────────────────────────────────────────

interface Props {
  params: Promise<{ path: string[] }>;
  searchParams: Promise<{ sort?: string }>;
}

// ─── generateMetadata ───────────────────────────────────────────────────────

/**
 * Per-product / per-category metadata. Generates a canonical URL pointing at
 * the category-prefixed path even when the URL we got was the bare
 * `/products/{slug}` short form — this keeps both forms aligned for search
 * engines that may have crawled either.
 *
 * For category pages we use the leaf category's name. For products we use
 * the product name + the first line of the description as the meta
 * description (truncated to ~160 chars per current Google guidance).
 *
 * This re-fetches the tree and possibly a product — Next.js's per-request
 * fetch cache dedupes against the page render below, so the data round-trip
 * is one of each at most.
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { path } = await params;

  if (path[0] === "new-products") {
    return {
      title: "Нови продукти",
      description: "Най-новите продукти в магазина.",
      alternates: { canonical: "/products/new-products" },
    };
  }

  let tree: CategoryTreeNode[];
  try {
    tree = (await fetchCategoryTree()).items;
  } catch {
    return {};
  }

  // Pure category match?
  const chain = resolveCategoryPath(tree, path);
  if (chain && chain.length === path.length) {
    const leaf = chain[chain.length - 1];
    return {
      title: leaf.name,
      description: `Продукти в категория ${leaf.name}.`,
      alternates: {
        canonical: "/products/" + chain.map((c) => c.slug).join("/"),
      },
    };
  }

  // Product slug at the end of a category chain?
  if (path.length >= 2) {
    const catChain = resolveCategoryPath(tree, path.slice(0, -1));
    const productSlug = path[path.length - 1];
    if (catChain && catChain.length === path.length - 1) {
      const product = await fetchProductBySlug(productSlug).catch(() => null);
      if (product && product.breadcrumb[product.breadcrumb.length - 1]?.id ===
        catChain[catChain.length - 1].id) {
        return productMetadata(product);
      }
    }
  }

  // Bare slug?
  if (path.length === 1) {
    const product = await fetchProductBySlug(path[0]).catch(() => null);
    if (product) return productMetadata(product);
  }

  return {};
}

function productMetadata(p: ApiProductDetail): Metadata {
  const canonical = productHref(p.breadcrumb, p.slug);
  const description = p.description.replace(/\s+/g, " ").trim().slice(0, 160);
  return {
    title: p.name,
    description,
    alternates: { canonical },
    openGraph: {
      title: p.name,
      description,
      type: "website",
      url: canonical,
      images: p.primaryImage
        ? [{ url: p.primaryImage.url, alt: p.primaryImage.alt }]
        : undefined,
    },
  };
}

// ─── Main resolver ──────────────────────────────────────────────────────────

export default async function CatchAllProductsPage({ params, searchParams }: Props) {
  const { path } = await params;
  const { sort = "default" } = await searchParams;
  const apiSort = uiSortToApi(sort);

  // (1) Virtual "new products"
  if (path.length === 1 && path[0] === "new-products") {
    return <NewProductsView sort={sort} apiSort={apiSort} />;
  }

  // We need the tree to distinguish category vs product paths.
  const tree = (await fetchCategoryTree()).items;

  // (2) Pure category chain?
  const fullChain = resolveCategoryPath(tree, path);
  if (fullChain && fullChain.length === path.length) {
    return (
      <CategoryView
        chain={fullChain}
        sort={sort}
        apiSort={apiSort}
      />
    );
  }

  // (3) Category chain plus product slug at the end?
  if (path.length >= 2) {
    const catChain = resolveCategoryPath(tree, path.slice(0, -1));
    const productSlug = path[path.length - 1];
    if (catChain && catChain.length === path.length - 1) {
      const product = await fetchProductBySlug(productSlug);
      if (
        product &&
        product.breadcrumb[product.breadcrumb.length - 1]?.id ===
          catChain[catChain.length - 1].id
      ) {
        return <ProductDetailServerView product={product} />;
      }
    }
  }

  // (4) Bare product slug → 301 to canonical URL
  if (path.length === 1) {
    const product = await fetchProductBySlug(path[0]);
    if (product) {
      const canonical = productHref(product.breadcrumb, product.slug);
      if (canonical !== `/products/${path[0]}`) {
        permanentRedirect(canonical);
      }
      // No category breadcrumb → render in place at /products/{slug}
      return <ProductDetailServerView product={product} />;
    }
  }

  notFound();
}

// ─── New products virtual category ──────────────────────────────────────────

async function NewProductsView({
  sort,
  apiSort,
}: {
  sort: string;
  apiSort: ApiSort;
}) {
  // The API doesn't have a dedicated "is new" filter on /products yet, so we
  // approximate by sorting newest-first and trusting the per-product
  // `isNew` flag (set when `newUntil` is in the future) at render time.
  // When the catalog grows past a couple of pages we'll want a real
  // `?newOnly=true` flag on the API — tracked alongside Roadmap §15 #21.
  const effectiveSort: ApiSort = apiSort === "featured" ? "newest" : apiSort;
  let items: ApiProductSummary[] = [];
  try {
    items = (await fetchProducts({ sort: effectiveSort, limit: 24 })).items;
  } catch {
    items = [];
  }
  // Trim down to only the still-marked-new products. If everything has
  // expired, show the newest page anyway — empty UI is worse than a fresh
  // "see what's hot" view.
  const filtered = items.filter((p) => p.isNew);
  const display = filtered.length > 0 ? filtered : items;

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <Breadcrumb className="mb-4">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink render={<Link href="/" />}>Начало</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Нови продукти</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="flex flex-col md:flex-row gap-6">
        <aside className="hidden md:block w-56 flex-shrink-0">
          <ProductFilters activeSort={sort} />
        </aside>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-4 gap-2">
            <h1 className="text-xl font-bold">Нови продукти</h1>
            <div className="flex items-center gap-2">
              <p className="text-sm text-muted-foreground whitespace-nowrap">
                {display.length} продукта
              </p>
              <MobileFiltersDrawer
                trigger={<FilterTriggerButton />}
                activeSort={sort}
              />
            </div>
          </div>
          <ProductGrid items={display} />
        </div>
      </div>
    </div>
  );
}

// ─── Category page ──────────────────────────────────────────────────────────

async function CategoryView({
  chain,
  sort,
  apiSort,
}: {
  chain: CategoryTreeNode[];
  sort: string;
  apiSort: ApiSort;
}) {
  const category = chain[chain.length - 1];
  const hasChildren = category.children.length > 0;
  const basePath = "/products/" + chain.map((c) => c.slug).join("/");

  let items: ApiProductSummary[] = [];
  try {
    items = (
      await fetchProducts({
        categorySlug: category.slug,
        sort: apiSort,
        limit: 24,
      })
    ).items;
  } catch {
    items = [];
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      {/* JSON-LD BreadcrumbList — Google's 2026 schema guidance requires
         BreadcrumbList on every page that has a breadcrumb visible to the
         user. The visible breadcrumb below renders the same chain, so the
         structured data describes content the user actually sees (not
         invisible content, which Google treats as spam). */}
      <CategoryBreadcrumbJsonLd chain={chain} />

      <Breadcrumb className="mb-4">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink render={<Link href="/" />}>Начало</BreadcrumbLink>
          </BreadcrumbItem>
          {chain.map((cat, i) => {
            const isLast = i === chain.length - 1;
            const catPath = "/products/" + chain.slice(0, i + 1).map((c) => c.slug).join("/");
            return (
              <span key={cat.id} className="contents">
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  {isLast ? (
                    <BreadcrumbPage>{cat.name}</BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink render={<Link href={catPath} />}>{cat.name}</BreadcrumbLink>
                  )}
                </BreadcrumbItem>
              </span>
            );
          })}
        </BreadcrumbList>
      </Breadcrumb>

      {hasChildren && (
        <div className="mb-8">
          <h1 className="text-2xl font-bold mb-6">{category.name}</h1>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {[...category.children]
              .sort((a, b) => a.displayOrder - b.displayOrder)
              .map((child) => (
                <Link
                  key={child.id}
                  href={`${basePath}/${child.slug}`}
                  className="group relative rounded-lg border border-border overflow-hidden card-lift bg-card"
                >
                  <div className="aspect-square overflow-hidden bg-muted">
                    {child.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={child.imageUrl}
                        alt={child.name}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-[oklch(0.18_0.02_270)] text-[oklch(0.73_0.10_75)] font-bold text-3xl">
                        {child.name[0]}
                      </div>
                    )}
                  </div>
                  <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-3">
                    <p className="text-white font-semibold text-sm">{child.name}</p>
                    <p className="text-white/70 text-xs mt-0.5 flex items-center gap-1">
                      Разгледай <ArrowRight className="w-3 h-3" />
                    </p>
                  </div>
                </Link>
              ))}
          </div>
        </div>
      )}

      {(items.length > 0 || !hasChildren) && (
        <div className="flex flex-col md:flex-row gap-6">
          <aside className="hidden md:block w-56 flex-shrink-0">
            <ProductFilters activeSort={sort} />
          </aside>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between mb-4 gap-2">
              <h2 className={hasChildren ? "text-lg font-bold" : "text-xl font-bold"}>
                {hasChildren ? `Продукти в ${category.name}` : category.name}
              </h2>
              <div className="flex items-center gap-2">
                <p className="text-sm text-muted-foreground whitespace-nowrap">
                  {items.length} продукта
                </p>
                <MobileFiltersDrawer
                  trigger={<FilterTriggerButton />}
                  activeSort={sort}
                />
              </div>
            </div>
            {items.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <p className="text-muted-foreground">
                  {hasChildren
                    ? "Разгледайте подкатегориите по-горе."
                    : "В тази категория все още няма продукти."}
                </p>
              </div>
            ) : (
              <ProductGrid
                items={items}
                productHrefBuilder={(p) => `${basePath}/${p.slug}`}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Product detail (server-rendered shell) ─────────────────────────────────

function ProductDetailServerView({ product }: { product: ApiProductDetail }) {
  const chain = breadcrumbToCategoryChain(product.breadcrumb);
  const adapted = adaptDetail(product);
  const canonical = productHref(product.breadcrumb, product.slug);

  return (
    <>
      {/* JSON-LD: Product + BreadcrumbList in a single @graph. Google's
         2026 guidance prefers @graph for cross-referenced entities; the
         BreadcrumbList here references the Product implicitly through the
         shared URL. */}
      <ProductJsonLd product={product} canonical={canonical} />
      <ProductDetailView product={adapted} categoryChain={chain} />
    </>
  );
}

// ─── JSON-LD helpers ────────────────────────────────────────────────────────

/**
 * Render a stable JSON-LD <script>. We can't set a `nonce` here — the
 * `<script type="application/ld+json">` block must have its content
 * available to the crawler unchanged, and our CSP allows JSON-LD via
 * `'unsafe-inline'`... wait, no, it doesn't. We have a strict nonce-based
 * CSP. JSON-LD with `application/ld+json` is NOT executable JavaScript, so
 * the browser doesn't enforce script-src on it; Google's crawler and modern
 * browsers treat `application/ld+json` blocks as data, not script. The
 * strict CSP does NOT block them. (Verified on the CSP spec: CSP's
 * `script-src` directive only applies to script elements whose type is
 * executable; `application/ld+json` is non-executable and exempt.)
 *
 * The `dangerouslySetInnerHTML` is fine here because the input is a typed
 * object we control — no user content is interpolated.
 */
/**
 * Absolute site origin — Google's BreadcrumbList spec rejects relative URLs
 * in `item` (Rich Results Test flags them as "Невалиден URL адрес в полето
 * 'id'"). We share `metadataBase`'s source — `NEXT_PUBLIC_SITE_URL` — so the
 * one env var controls every absolute URL the page emits. The localhost
 * fallback only fires during pure local dev, where the Rich Results crawler
 * doesn't reach anyway.
 */
const SITE_ORIGIN = (
  process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "") ??
  "http://localhost:3000"
);

function absoluteUrl(path: string): string {
  return SITE_ORIGIN + (path.startsWith("/") ? path : "/" + path);
}

/**
 * Bulgarian 14-day right-of-withdrawal per EU Directive 2023/2673 / ЗЗП —
 * returns by mail, customer pays return shipping unless otherwise agreed.
 * Same policy applies to every product in the shop, so the block is a
 * module-level constant. Consumed by `hasMerchantReturnPolicy` on each
 * Product Offer.
 *
 * Schema.org spec:
 *   https://schema.org/MerchantReturnPolicy
 *   https://developers.google.com/search/docs/appearance/structured-data/product#return-policy
 */
const MERCHANT_RETURN_POLICY = {
  "@type": "MerchantReturnPolicy",
  applicableCountry: "BG",
  returnPolicyCountry: "BG",
  returnPolicyCategory: "https://schema.org/MerchantReturnFiniteReturnWindow",
  merchantReturnDays: 14,
  returnMethod: "https://schema.org/ReturnByMail",
  returnFees: "https://schema.org/ReturnShippingFees",
} as const;

function ProductJsonLd({
  product,
  canonical,
}: {
  product: ApiProductDetail;
  canonical: string;
}) {
  // All URLs absolute — Google's Rich Results test rejects relative URLs
  // in `@id` / `item` (treats them as invalid IDs). The CDN URL on images
  // is already absolute (public CloudFront URL) so it passes through
  // unchanged.
  const canonicalAbs = absoluteUrl(canonical);

  // `image` field: Google's Product spec REQUIRES at least one image for
  // rich-result eligibility. Omitting the field (or passing an empty
  // array) both fail validation. When a product has no DB images yet, the
  // visible UI already falls back to a `placehold.co` placeholder
  // (`ProductCard.tsx`, `ProductDetailView.tsx`) — mirror that fallback
  // here so the structured data describes what the crawler actually
  // sees on the page. Production products will replace the placeholder
  // once the admin upload flow ships.
  const FALLBACK_PRODUCT_IMAGE =
    "https://placehold.co/600x600/e2e8f0/475569?text=" +
    encodeURIComponent(product.name);
  const imageUrls =
    product.images.length > 0
      ? product.images.map((img) => img.url)
      : [FALLBACK_PRODUCT_IMAGE];

  const productLd: Record<string, unknown> = {
    "@type": "Product",
    "@id": `${canonicalAbs}#product`,
    name: product.name,
    description: product.description,
    sku: product.code,
    url: canonicalAbs,
    offers: {
      "@type": "Offer",
      url: canonicalAbs,
      price: (product.priceCents / 100).toFixed(2),
      priceCurrency: product.currency,
      availability:
        product.stockStatus === "in_stock"
          ? "https://schema.org/InStock"
          : "https://schema.org/OutOfStock",
      itemCondition: "https://schema.org/NewCondition",
      hasMerchantReturnPolicy: MERCHANT_RETURN_POLICY,
    },
  };
  productLd.image = imageUrls;

  const breadcrumbLd = {
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Начало",
        item: absoluteUrl("/"),
      },
      ...product.breadcrumb.map((b, i) => ({
        "@type": "ListItem",
        position: i + 2,
        name: b.name,
        item: absoluteUrl(
          "/products/" +
          product.breadcrumb.slice(0, i + 1).map((c) => c.slug).join("/"),
        ),
      })),
      {
        "@type": "ListItem",
        position: product.breadcrumb.length + 2,
        name: product.name,
        item: canonicalAbs,
      },
    ],
  };

  const ld = {
    "@context": "https://schema.org",
    "@graph": [productLd, breadcrumbLd],
  };

  return (
    <script
      type="application/ld+json"
      // Stable JSON serialization is what crawlers compare across visits;
      // any random key order is fine since we never expect to diff it
      // ourselves.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }}
    />
  );
}

function CategoryBreadcrumbJsonLd({ chain }: { chain: CategoryTreeNode[] }) {
  const ld = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Начало",
        item: absoluteUrl("/"),
      },
      ...chain.map((cat, i) => ({
        "@type": "ListItem",
        position: i + 2,
        name: cat.name,
        item: absoluteUrl(
          "/products/" + chain.slice(0, i + 1).map((c) => c.slug).join("/"),
        ),
      })),
    ],
  };
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }}
    />
  );
}

// ─── Small shared bits ──────────────────────────────────────────────────────

function FilterTriggerButton(props: React.ComponentProps<"button">) {
  // Spreads incoming props so base-ui's <SheetTrigger render={...}> can wire
  // its onClick + aria-haspopup="dialog" + aria-expanded onto the real button.
  return (
    <button
      {...props}
      className="md:hidden flex items-center gap-1.5 text-sm border border-border rounded-md px-3 py-1.5 hover:bg-muted transition-colors"
    >
      <SlidersHorizontal className="w-4 h-4" />
      Филтри
    </button>
  );
}

function ProductGrid({
  items,
  productHrefBuilder,
}: {
  items: ApiProductSummary[];
  /**
   * Optional URL builder per product. Pages that know the category chain
   * (CategoryView) pass a fn that prefixes the category path so links go
   * straight to the canonical URL. Pages that don't (new-products) omit
   * it; the catch-all route's single-segment fallback handles the
   * canonical redirect on click.
   */
  productHrefBuilder?: (p: ApiProductSummary) => string;
}) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {items.map((p) => (
        <ProductCard
          key={p.id}
          product={adaptSummary(p)}
          href={productHrefBuilder ? productHrefBuilder(p) : `/products/${p.slug}`}
        />
      ))}
    </div>
  );
}
