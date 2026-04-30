import Link from "next/link";
import { searchProducts } from "@/lib/mock-data/products";
import ProductCard from "@/components/shop/ProductCard";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Search } from "lucide-react";

interface Props {
  searchParams: Promise<{ q?: string }>;
}

export default async function SearchPage({ searchParams }: Props) {
  const { q = "" } = await searchParams;
  const results = q.trim().length >= 2 ? searchProducts(q) : [];

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      {/* Search form */}
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

      {q ? (
        <>
          <h1 className="text-xl font-bold mb-1">
            Резултати за &ldquo;{q}&rdquo;
          </h1>
          <p className="text-sm text-muted-foreground mb-6">
            {results.length} {results.length === 1 ? "продукт" : "продукта"}
          </p>

          {results.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
              {results.map((p) => (
                <ProductCard key={p.id} product={p} />
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
              <ButtonLink variant="outline" href="/products">Виж всички продукти</ButtonLink>
            </div>
          )}
        </>
      ) : (
        <div className="flex flex-col items-center py-20 text-center gap-4">
          <Search className="w-12 h-12 text-muted-foreground/40" />
          <p className="text-muted-foreground">Въведете дума за търсене</p>
        </div>
      )}
    </div>
  );
}
