"use client";

import Link from "next/link";
import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { Search, ShoppingCart, User, X, LogOut, Package, Settings } from "lucide-react";
import { useCart } from "@/contexts/CartContext";
import { useAuth } from "@/contexts/AuthContext";
import { searchProducts } from "@/lib/mock-data/products";
import { getCategoryAncestors } from "@/lib/mock-data/categories";
import CartDrawer from "@/components/shop/CartDrawer";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatPrice } from "@/lib/utils";

export default function Header() {
  const { itemCount } = useCart();
  const { user, logout, isLoggedIn } = useAuth();
  const [cartOpen, setCartOpen] = useState(false);
  const [searchQuery, setSearchQueryState] = useState("");
  // `dismissed` controls whether the autocomplete popup is hidden after the
  // user has actively closed it (outside-click, clear button, suggestion
  // pick). It's intentionally separate from `searchQuery` so the popup can
  // re-open when the user resumes typing without us re-running the search
  // from scratch.
  const [dismissed, setDismissed] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);

  // `suggestions` is purely derived from `searchQuery` — compute during
  // render rather than chasing it from a useEffect. searchProducts works
  // against an in-memory mock list today, so the cost is trivial; when the
  // real /products?q= search lands this becomes a Suspense-driven
  // `use(fetchSuggestions(searchQuery))` instead.
  const suggestions = useMemo(
    () =>
      searchQuery.trim().length >= 2
        ? searchProducts(searchQuery).slice(0, 5)
        : [],
    [searchQuery],
  );

  // `showSuggestions` is also derived: if the user hasn't dismissed and we
  // have results, show the popup.
  const showSuggestions = !dismissed && suggestions.length > 0;

  // Wrap setSearchQuery so resuming typing re-opens the popup without the
  // caller having to know about the dismissed flag.
  const setSearchQuery = useCallback((value: string) => {
    setSearchQueryState(value);
    setDismissed(false);
  }, []);

  // Close suggestions on outside click. The setState here is event-driven
  // (a real DOM event fires it), not a render-time derivation, so it's the
  // canonical useEffect use case.
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setDismissed(true);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <>
      <header className="bg-white/95 backdrop-blur-sm border-b border-border sticky top-0 z-40 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center gap-4">
          {/* Logo */}
          <Link href="/" className="flex-shrink-0 flex items-center gap-2">
            <div className="w-8 h-8 rounded bg-[oklch(0.18_0.02_270)] flex items-center justify-center text-[oklch(0.73_0.10_75)] font-bold text-sm ring-1 ring-[oklch(0.73_0.10_75)]/30">
              D
            </div>
            <span className="font-bold text-lg hidden sm:block">Duda 1</span>
          </Link>

          {/* Search – desktop */}
          <div ref={searchRef} className="flex-1 max-w-xl hidden sm:block relative">
            <form
              action="/search"
              onSubmit={(e) => {
                e.preventDefault();
                if (searchQuery.trim()) {
                  window.location.href = `/search?q=${encodeURIComponent(searchQuery)}`;
                }
              }}
              className="relative"
            >
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <input
                type="search"
                placeholder="Търси продукти..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onFocus={() => setDismissed(false)}
                className="w-full h-9 pl-9 pr-4 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring"
                aria-label="Търси продукти"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => { setSearchQuery(""); setDismissed(true); }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label="Изчисти търсенето"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </form>

            {/* Autocomplete dropdown */}
            {showSuggestions && suggestions.length > 0 && (
              <div className="absolute top-full mt-1 left-0 right-0 bg-white border border-border rounded-md shadow-lg z-50">
                {suggestions.map((p) => {
                  const ancestors = getCategoryAncestors(p.categoryId);
                  const productUrl = ancestors.length > 0
                    ? `/products/${ancestors.map((c) => c.slug).join("/")}/${p.slug}`
                    : `/products/${p.slug}`;
                  return (
                  <Link
                    key={p.id}
                    href={productUrl}
                    onClick={() => { setSearchQuery(""); setDismissed(true); }}
                    className="flex items-center gap-3 px-3 py-2 hover:bg-muted transition-colors text-sm"
                  >
                    <div className="w-8 h-8 flex-shrink-0 rounded bg-muted overflow-hidden">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={p.images[0]?.url} alt={p.name} className="w-full h-full object-cover" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{p.name}</p>
                      <p className="text-muted-foreground text-xs">{p.code}</p>
                    </div>
                    <span className="font-semibold text-primary whitespace-nowrap">
                      {formatPrice(p.price)}
                    </span>
                  </Link>
                  );
                })}
                <Link
                  href={`/search?q=${encodeURIComponent(searchQuery)}`}
                  onClick={() => setDismissed(true)}
                  className="block px-3 py-2 text-sm text-primary font-medium border-t border-border hover:bg-muted transition-colors text-center"
                >
                  Виж всички резултати за &ldquo;{searchQuery}&rdquo;
                </Link>
              </div>
            )}
          </div>

          {/* Right controls */}
          <div className="flex items-center gap-2 ml-auto sm:ml-0">
            {/* Mobile search icon */}
            <Link
              href="/search"
              className="sm:hidden p-2 rounded-md hover:bg-muted transition-colors"
              aria-label="Търси"
            >
              <Search className="w-5 h-5" />
            </Link>

            {/* Account */}
            {isLoggedIn ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  className="flex items-center gap-1.5 p-2 rounded-md hover:bg-muted transition-colors text-sm"
                  aria-label="Акаунт"
                >
                  <User className="w-5 h-5" />
                  <span className="hidden md:block font-medium">{user?.fullName?.split(/\s+/)[0] ?? user?.email ?? ""}</span>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem render={<Link href="/account/profile" />}>
                    <User className="w-4 h-4 mr-2" /> Профил
                  </DropdownMenuItem>
                  <DropdownMenuItem render={<Link href="/account/orders" />}>
                    <Package className="w-4 h-4 mr-2" /> Поръчки
                  </DropdownMenuItem>
                  {user?.role === "admin" && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem render={<Link href="/admin" />}>
                        <Settings className="w-4 h-4 mr-2" /> Администрация
                      </DropdownMenuItem>
                    </>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={logout} className="text-destructive focus:text-destructive">
                    <LogOut className="w-4 h-4 mr-2" /> Изход
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Link
                href="/account/login"
                className="flex items-center gap-1.5 p-2 rounded-md hover:bg-muted transition-colors text-sm"
                aria-label="Вход"
              >
                <User className="w-5 h-5" />
                <span className="hidden md:block">Вход</span>
              </Link>
            )}

            {/* Cart */}
            <button
              onClick={() => setCartOpen(true)}
              className="relative p-2 rounded-md hover:bg-muted transition-colors"
              aria-label={`Количка – ${itemCount} продукта`}
            >
              <ShoppingCart className="w-5 h-5" />
              {itemCount > 0 && (
                <Badge className="absolute -top-1 -right-1 h-5 min-w-5 px-1 flex items-center justify-center text-xs rounded-full bg-primary text-primary-foreground border-2 border-white">
                  {itemCount > 99 ? "99+" : itemCount}
                </Badge>
              )}
            </button>
          </div>
        </div>
      </header>

      <CartDrawer open={cartOpen} onClose={() => setCartOpen(false)} />
    </>
  );
}
