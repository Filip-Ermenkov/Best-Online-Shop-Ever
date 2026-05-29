import { Search } from "lucide-react";
import { fetchProducts } from "@/lib/api";
import type { Product } from "@/lib/types";
import ProductCard from "@/components/shop/ProductCard";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";

/**
 * Search results page.
 *
 * Server Component — the query is in the URL (`?q=…`) so the page renders
 * fully on the server with the matching products embedded in first paint.
 * That's the right move for SEO (search-results pages don't necessarily
 * deserve indexing, but they get linked between themselves and from
 * autocomplete suggestions, and we want the link target rendered without
 * a client-side waterfall).
 *
 * The API's `q` parameter does an ILIKE on product name + product code,
 * server-side (`backend/shop-api/src/routes/products.ts` line ~260). It's
 * not yet a real full-text search — that's the `tsvector` upgrade documented
 * in `docs/ARCHITECTURE.md` §16.3, triggered when the catalog crosses
 * ~20K SKUs. Until then ILIKE on a few hundred rows is plenty.
 *
 * The minimum query length (2 chars) is enforced both client-side (the
 * header autocomplete bails below that) and server-side (the API rejects
 * `q.length < 1`). This page applies the same UX threshold for consistency.
 */

const MIN_QUERY_LENGTH = 2;
const SEARCH_PAGE_SIZE = 24;

interface Props {
  searchParams: Promise<{ q?: string }>;
}

export const metadata = {
  // Empty search results page should not be indexed — it provides no
  // standalone content. Once a query is present we still don't index;
  // search-results pages are a known low-quality signal for Google.
  robots: { index: false, follow: true },
};

export default async function SearchPage({ searchParams }: Props) {
  const { q = "" } = await searchParams;
  const trimmed = q.trim();
  const hasValidQuery = trimmed.length >= MIN_QUERY_LENGTH;

  // Fetch on the server. Short-circuit if the query is too short — the API
  // would otherwise reject as 400 and the empty-state below handles it
  // cleanly without surfacing the error.
  let results: ApiProductSummary[] = [];
  let hasMore = false;
  if (hasValidQuery) {
    try {
      const page = await fetchProducts({ q: trimmed, limit: SEARCH_PAGE_SIZE });
      results = page.items;
      hasMore = page.nextCursor !== null;
    } catch {
      // API down → render with empty results + a soft error message in
      // the empty state. Don't surface raw error to the user; the
      // top-level error.tsx covers genuine outages.
    }
  }

  const adapted = results.map(adaptApiProductToFrontend);

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <form method="get" action="/search" className="flex gap-2 max-w-xl mb-8">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            name="q"
            defaultValue={q}
            placeholder="Търси продукти..."
            className="pl-9"
            autoFocus
          />
        </div>
        <Button type="submit">Търси</Button>
      </form>

      {hasValidQuery ? (
        <>
          <h1 className="text-xl font-bold mb-1">
            Резултати за &ldquo;{trimmed}&rdquo;
          </h1>
          <p className="text-sm text-muted-foreground mb-6">
            {results.length}
            {hasMore ? "+" : ""} {results.length === 1 ? "продукт" : "продукта"}
          </p>

          {adapted.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
              {adapted.map((p) => (
                // The search summary doesn't carry the breadcrumb, so we
                // link with the short form; the catch-all route's
                // single-segment product fallback handles the canonical
                // redirect.
                <ProductCard key={p.id} product={p} href={`/products/${p.slug}`} />
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center py-20 text-center gap-4">
              <Search className="w-12 h-12 text-muted-foreground/40" />
              <div>
                <p className="font-medium">Няма намерени продукти</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Опитайте с различни ключови думи или разгледайте категориите.
                </p>
              </div>
              <ButtonLink variant="outline" href="/">
                Виж всички продукти
              </ButtonLink>
            </div>
          )}
        </>
      ) : (
        <div className="flex flex-col items-center py-20 text-center gap-4">
          <Search className="w-12 h-12 text-muted-foreground/40" />
          <p className="text-muted-foreground">
            {q.length > 0
              ? `Въведете поне ${MIN_QUERY_LENGTH} символа за търсене.`
              : "Въведете дума за търсене"}
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Adapter ────────────────────────────────────────────────────────────────

type ApiProductSummary = Awaited<
  ReturnType<typeof fetchProducts>
>["items"][number];

/**
 * Same adapter as `(shop)/page.tsx` — converts the API DTO into the
 * frontend's local `Product` shape that `ProductCard` consumes today. Will
 * disappear when ProductCard is migrated to take the API DTO directly
 * (separate slice).
 */
function adaptApiProductToFrontend(p: ApiProductSummary): Product {
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
