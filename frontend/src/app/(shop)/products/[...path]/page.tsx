"use client";

import Link from "next/link";
import { use, useState, useMemo } from "react";
import { notFound } from "next/navigation";
import { ArrowRight, SlidersHorizontal, ShoppingCart, Minus, Plus } from "lucide-react";
import {
  resolveCategoryPath, getCategoryAncestors, getCategoryBySlug,
  NEW_PRODUCTS_CATEGORY,
} from "@/lib/mock-data/categories";
import { getProductsByCategoryId, getProductBySlug, getNewProducts } from "@/lib/mock-data/products";
import { CategoryNode, Product } from "@/lib/types";
import ProductCard from "@/components/shop/ProductCard";
import ProductFilters from "@/components/shop/ProductFilters";
import MobileFiltersDrawer from "@/components/shop/MobileFiltersDrawer";
import ProductDetailView from "@/components/shop/ProductDetailView";
import {
  Breadcrumb, BreadcrumbItem, BreadcrumbLink,
  BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

interface Props {
  params: Promise<{ path: string[] }>;
  searchParams: Promise<{ sort?: string; minPrice?: string; maxPrice?: string }>;
}

export default function CatchAllProductsPage({ params, searchParams }: Props) {
  const { path } = use(params);
  const { sort = "default", minPrice, maxPrice } = use(searchParams);

  // --- Resolve: is this a category page or product detail? ---
  const isNewProducts = path.length === 1 && path[0] === "new-products";

  if (isNewProducts) {
    return (
      <NewProductsPage sort={sort} minPrice={minPrice} maxPrice={maxPrice} />
    );
  }

  // Try to resolve the full path as categories
  const categoryChain = resolveCategoryPath(path);

  if (categoryChain && categoryChain.length === path.length) {
    // All segments matched categories → category page
    const category = categoryChain[categoryChain.length - 1];
    return (
      <CategoryPageView
        category={category}
        ancestorChain={categoryChain}
        sort={sort}
        minPrice={minPrice}
        maxPrice={maxPrice}
      />
    );
  }

  // Last segment might be a product slug
  if (path.length >= 2) {
    const categoryPath = path.slice(0, -1);
    const productSlug = path[path.length - 1];
    const catChain = resolveCategoryPath(categoryPath);
    if (catChain && catChain.length === categoryPath.length) {
      const product = getProductBySlug(productSlug);
      if (product && product.categoryId === catChain[catChain.length - 1].id) {
        return <ProductDetailView product={product} categoryChain={catChain} />;
      }
    }
  }

  // Nothing matched
  notFound();
}

// ─── New Products (virtual category) ────────────────────────────────────────

function NewProductsPage({ sort, minPrice, maxPrice }: { sort: string; minPrice?: string; maxPrice?: string }) {
  let products = getNewProducts();
  products = applyFilters(products, sort, minPrice, maxPrice);
  const { priceMin, priceMax } = getPriceRange(products);

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <Breadcrumb className="mb-4">
        <BreadcrumbList>
          <BreadcrumbItem><BreadcrumbLink render={<Link href="/" />}>Начало</BreadcrumbLink></BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem><BreadcrumbPage>{NEW_PRODUCTS_CATEGORY.name}</BreadcrumbPage></BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="flex flex-col md:flex-row gap-6">
        <aside className="hidden md:block w-56 flex-shrink-0">
          <ProductFilters
            category={NEW_PRODUCTS_CATEGORY}
            activeSort={sort}
            priceMin={priceMin}
            priceMax={priceMax}
          />
        </aside>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-4 gap-2">
            <h1 className="text-xl font-bold">{NEW_PRODUCTS_CATEGORY.name}</h1>
            <div className="flex items-center gap-2">
              <p className="text-sm text-muted-foreground whitespace-nowrap">{products.length} продукта</p>
              <MobileFiltersDrawer
                trigger={<FilterTriggerButton />}
                category={NEW_PRODUCTS_CATEGORY}
                activeSort={sort}
                priceMin={priceMin}
                priceMax={priceMax}
              />
            </div>
          </div>
          <ProductGrid products={products} />
        </div>
      </div>
    </div>
  );
}

// ─── Category Page ──────────────────────────────────────────────────────────

function CategoryPageView({
  category, ancestorChain, sort, minPrice, maxPrice,
}: {
  category: CategoryNode;
  ancestorChain: CategoryNode[];
  sort: string;
  minPrice?: string;
  maxPrice?: string;
}) {
  let products = getProductsByCategoryId(category.id);
  products = applyFilters(products, sort, minPrice, maxPrice);
  const { priceMin, priceMax } = getPriceRange(products);

  const hasChildren = category.children.filter((c) => !c.isArchived).length > 0;
  const basePath = "/products/" + ancestorChain.map((c) => c.slug).join("/");

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      {/* Breadcrumb */}
      <Breadcrumb className="mb-4">
        <BreadcrumbList>
          <BreadcrumbItem><BreadcrumbLink render={<Link href="/" />}>Начало</BreadcrumbLink></BreadcrumbItem>
          {ancestorChain.map((cat, i) => {
            const isLast = i === ancestorChain.length - 1;
            const catPath = "/products/" + ancestorChain.slice(0, i + 1).map((c) => c.slug).join("/");
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

      {/* Subcategory card grid */}
      {hasChildren && (
        <div className="mb-8">
          <h1 className="text-2xl font-bold mb-6">{category.name}</h1>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {category.children
              .filter((c) => !c.isArchived)
              .sort((a, b) => a.order - b.order)
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

      {/* Product grid with filters */}
      {(products.length > 0 || !hasChildren) && (
        <div className="flex flex-col md:flex-row gap-6">
          <aside className="hidden md:block w-56 flex-shrink-0">
            <ProductFilters
              category={category}
              activeSort={sort}
              priceMin={priceMin}
              priceMax={priceMax}
            />
          </aside>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between mb-4 gap-2">
              <h2 className={hasChildren ? "text-lg font-bold" : "text-xl font-bold"}>
                {hasChildren ? `Продукти в ${category.name}` : category.name}
              </h2>
              <div className="flex items-center gap-2">
                <p className="text-sm text-muted-foreground whitespace-nowrap">{products.length} продукта</p>
                <MobileFiltersDrawer
                  trigger={<FilterTriggerButton />}
                  category={category}
                  activeSort={sort}
                  priceMin={priceMin}
                  priceMax={priceMax}
                />
              </div>
            </div>
            {products.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <p className="text-muted-foreground">
                  {hasChildren
                    ? "Разгледайте подкатегориите по-горе."
                    : "В тази категория все още няма продукти."}
                </p>
              </div>
            ) : (
              <ProductGrid products={products} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

function FilterTriggerButton() {
  return (
    <button className="md:hidden flex items-center gap-1.5 text-sm border border-border rounded-md px-3 py-1.5 hover:bg-muted transition-colors">
      <SlidersHorizontal className="w-4 h-4" />
      Филтри
    </button>
  );
}

function ProductGrid({ products }: { products: Product[] }) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {products.map((p) => (
        <ProductCard key={p.id} product={p} />
      ))}
    </div>
  );
}

function applyFilters(products: Product[], sort: string, minPrice?: string, maxPrice?: string): Product[] {
  let result = [...products];
  if (minPrice) result = result.filter((p) => p.price >= Number(minPrice));
  if (maxPrice) result = result.filter((p) => p.price <= Number(maxPrice));
  if (sort === "price_asc") result.sort((a, b) => a.price - b.price);
  if (sort === "price_desc") result.sort((a, b) => b.price - a.price);
  if (sort === "newest") result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  if (sort === "name_asc") result.sort((a, b) => a.name.localeCompare(b.name, "bg"));
  return result;
}

function getPriceRange(products: Product[]) {
  const prices = products.map((p) => p.price);
  return {
    priceMin: prices.length ? Math.floor(Math.min(...prices)) : 0,
    priceMax: prices.length ? Math.ceil(Math.max(...prices)) : 10000,
  };
}
