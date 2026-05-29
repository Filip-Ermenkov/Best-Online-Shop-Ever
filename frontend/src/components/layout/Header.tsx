"use client";

import Link from "next/link";
import { useState, useRef, useEffect, useCallback } from "react";
import { Search, ShoppingCart, User, X, LogOut, Package, Settings } from "lucide-react";
import { useCart } from "@/contexts/CartContext";
import { useAuth } from "@/contexts/AuthContext";
import { fetchProducts } from "@/lib/api";
import CartDrawer from "@/components/shop/CartDrawer";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatCents } from "@/lib/utils";

/**
 * Header is a Client Component because cart count, auth dropdown, and the
 * autocomplete popup all need React state. The header lives outside the page
 * that does the actual category-resolving SSR, so it talks to the API
 * through the typed `fetchProducts` helper in `lib/api.ts`.
 *
 * Why not call `api.products.$get(...)` directly? The raw `api` Hono RPC
 * client degrades to `unknown` whenever `AppType` (which is
 * `ReturnType<typeof buildApp>`) can't resolve cleanly across the workspace
 * symlink. That breaks `next build` with `Type error: 'api' is of type
 * 'unknown'`. The `fetchProducts` helper has an explicit
 * `Promise<ProductsPage>` return type that doesn't depend on the deep
 * AppType ReturnType chain, so it stays correctly typed regardless.
 *
 * Autocomplete contract:
 *   - Don't fire on every keystroke. Debounce 200 ms; bail if the query is
 *     <2 visible chars after trim.
 *   - Cancel in-flight requests via AbortController whenever the user
 *     resumes typing — the older response is no longer relevant and could
 *     overwrite the newer one (last-write-wins race).
 *   - Use the same `/products?q=…&limit=5` endpoint the search page uses;
 *     keeping one source of truth for "what products match this text".
 *   - Links route to bare `/products/{slug}`. The catch-all route has a
 *     single-segment product-slug fallback that resolves to the canonical
 *     URL via permanent redirect — so the SEO story is one canonical URL
 *     per product even when intermediate touch points (header, home, ad
 *     campaigns) use the short form.
 */

type SuggestionItem = {
  id: string;
  slug: string;
  code: string;
  name: string;
  priceCents: number;
  primaryImage: { url: string; alt: string } | null;
};

const AUTOCOMPLETE_DEBOUNCE_MS = 200;
const MIN_QUERY_LENGTH = 2;
const SUGGESTION_LIMIT = 5;

export default function Header() {
  const { itemCount } = useCart();
  const { user, logout, isLoggedIn } = useAuth();
  const [cartOpen, setCartOpen] = useState(false);
  const [searchQuery, setSearchQueryState] = useState("");
  const [dismissed, setDismissed] = useState(false);
  const [suggestions, setSuggestions] = useState<SuggestionItem[]>([]);
  const searchRef = useRef<HTMLDivElement>(null);

  const trimmedQuery = searchQuery.trim();
  const hasValidQuery = trimmedQuery.length >= MIN_QUERY_LENGTH;

  // Gate the dropdown on the CURRENT query length, not just on `suggestions`.
  // The effect below intentionally never calls `setSuggestions([])` in its
  // synchronous body (React 19's `react-hooks/set-state-in-effect` lint
  // rule flags that as an unnecessary extra render). Stale suggestions
  // from a previous query may linger in state when the user backspaces
  // below the minimum length, but `hasValidQuery` here ensures they're
  // never rendered, and the next valid-length query overwrites them via
  // the async callback below.
  const showSuggestions = !dismissed && hasValidQuery && suggestions.length > 0;

  const setSearchQuery = useCallback((value: string) => {
    setSearchQueryState(value);
    setDismissed(false);
  }, []);

  // Debounced fetch on query change. We use a single effect that re-runs on
  // every keystroke; the cleanup function clears the pending timeout AND
  // aborts any in-flight fetch, so only the most recent query's results win.
  useEffect(() => {
    if (!hasValidQuery) {
      // Skip both the timer and the fetch. We deliberately do NOT call
      // setSuggestions([]) here — see the comment above `showSuggestions`.
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        // `fetchProducts` returns a strongly-typed `ProductsPage` regardless
        // of how Hono RPC's AppType inference happens to resolve in the
        // current build, so `page.items.map(p => ...)` is safe.
        const page = await fetchProducts(
          { q: trimmedQuery, limit: SUGGESTION_LIMIT },
          { signal: controller.signal, cache: "no-store" },
        );
        setSuggestions(
          page.items.map((p) => ({
            id: p.id,
            slug: p.slug,
            code: p.code,
            name: p.name,
            priceCents: p.priceCents,
            primaryImage: p.primaryImage
              ? { url: p.primaryImage.url, alt: p.primaryImage.alt }
              : null,
          })),
        );
      } catch (err) {
        // AbortError is the expected outcome of typing fast — discard
        // silently. Other errors (network down, 500) also degrade to an
        // empty suggestions list rather than an inline error banner; the
        // user can press Enter and hit the full /search page which has
        // its own error handling.
        if ((err as { name?: string } | undefined)?.name === "AbortError") {
          return;
        }
        setSuggestions([]);
      }
    }, AUTOCOMPLETE_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // `trimmedQuery` and `hasValidQuery` are pure derivations of
    // `searchQuery`; listing them all keeps exhaustive-deps happy. React
    // dedupes the re-runs anyway — same `searchQuery` ⇒ same derived
    // values ⇒ Object.is-equal in the deps array ⇒ effect skips.
  }, [trimmedQuery, hasValidQuery]);

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
          <Link href="/" className="flex-shrink-0 flex items-center gap-2">
            <div className="w-8 h-8 rounded bg-[oklch(0.18_0.02_270)] flex items-center justify-center text-[oklch(0.73_0.10_75)] font-bold text-sm ring-1 ring-[oklch(0.73_0.10_75)]/30">
              D
            </div>
            <span className="font-bold text-lg hidden sm:block">Duda 1</span>
          </Link>

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

            {showSuggestions && (
              <div className="absolute top-full mt-1 left-0 right-0 bg-white border border-border rounded-md shadow-lg z-50">
                {suggestions.map((p) => (
                  <Link
                    key={p.id}
                    href={`/products/${p.slug}`}
                    onClick={() => { setSearchQuery(""); setDismissed(true); }}
                    className="flex items-center gap-3 px-3 py-2 hover:bg-muted transition-colors text-sm"
                  >
                    <div className="w-8 h-8 flex-shrink-0 rounded bg-muted overflow-hidden">
                      {p.primaryImage && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={p.primaryImage.url}
                          alt={p.primaryImage.alt}
                          className="w-full h-full object-cover"
                        />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{p.name}</p>
                      <p className="text-muted-foreground text-xs">{p.code}</p>
                    </div>
                    <span className="font-semibold text-primary whitespace-nowrap">
                      {formatCents(p.priceCents)}
                    </span>
                  </Link>
                ))}
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

          <div className="flex items-center gap-2 ml-auto sm:ml-0">
            <Link
              href="/search"
              className="sm:hidden p-2 rounded-md hover:bg-muted transition-colors"
              aria-label="Търси"
            >
              <Search className="w-5 h-5" />
            </Link>

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
