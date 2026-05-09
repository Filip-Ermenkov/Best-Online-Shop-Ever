"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAuth, type AuthStatus } from "@/contexts/AuthContext";
import {
  addCartItem,
  clearCart as clearServerCart,
  fetchCart,
  mergeCart,
  removeCartItem,
  setCartItemQuantity,
} from "@/lib/cart/client";
import {
  MAX_QUANTITY_PER_LINE,
  type CartError,
  type CartLine,
  type CartView,
  type GuestCartItem,
  type StockStatus,
} from "@/lib/cart/types";

/**
 * Two-mode cart provider.
 *
 *   Anonymous mode
 *   ──────────────
 *   The cart lives in sessionStorage under "shop_guest_cart". sessionStorage
 *   (not localStorage) per the README §5 spec — guest carts are per-tab and
 *   die with the tab. No network calls, no server state. Pages that show the
 *   cart can render directly from the snapshot embedded in each guest item.
 *
 *   Authenticated mode
 *   ──────────────────
 *   The cart lives on the server under /cart. Every mutation round-trips and
 *   the response IS the new view (the server returns the hydrated cart on
 *   every write — no separate read needed). We still keep the items in React
 *   state so consumers can re-render synchronously, with optimistic intent
 *   only on the simplest paths (set-quantity, remove). For add we wait on the
 *   server response so we get the live priceCents, stockStatus, and image.
 *
 *   Transitions
 *   ───────────
 *   anonymous → authenticated:
 *     We were a guest with N items, now logged in. POST /cart/merge with the
 *     guest cart, take the server response as the new cart, then DROP the
 *     sessionStorage guest cart so a future logout doesn't double-merge.
 *
 *   authenticated → anonymous:
 *     We were logged in, now anonymous (logged out / cookie expired). Drop
 *     the local items array. We do NOT repopulate sessionStorage — the spec
 *     wants logout to feel like leaving the shop.
 *
 *   loading → *:
 *     During the initial /auth/me bootstrap we render an empty cart. Once
 *     the auth status settles, the appropriate mode kicks in.
 *
 * Per spec, the cart "always shows the current live price". In authenticated
 * mode that comes for free — every read hydrates from the products table.
 * In anonymous mode the snapshot can drift (e.g. if the catalog changes a
 * price between the add and the page render). On login the merge response
 * resolves the drift authoritatively.
 */

const GUEST_CART_KEY = "shop_guest_cart";

// ─── Public types ──────────────────────────────────────────────────────────

// CartItem is currently structurally identical to CartLine. Kept as a named
// alias rather than a re-export so that future cart-only fields (e.g.
// `optimisticPending: boolean` for in-flight mutations) can land here without
// touching every caller. Type alias rather than `interface … extends` because
// @typescript-eslint/no-empty-object-type rightly flags the latter as a
// no-op declaration that's better expressed as an alias.
export type CartItem = CartLine;

export interface CartContextValue {
  items: CartItem[];
  /**
   *   "loading"   — initial bootstrap, server fetch in flight, or merge running.
   *   "ready"     — items are up-to-date with the source of truth (server or local).
   *   "mutating"  — a write is in flight; UI may show a subtle indicator.
   *   "error"     — last operation failed; see lastError. Items reflect best-
   *                 effort state (rolled back on failed optimistic updates).
   */
  status: "loading" | "ready" | "mutating" | "error";
  /** The most recent failure, cleared by the next successful mutation. */
  lastError: CartError | null;
  /** True iff the user is logged in. Convenience for UI gating. */
  isAuthenticated: boolean;

  itemCount: number;
  /** EUR cents, in-stock lines only. Matches server semantics. */
  subtotalCents: number;
  currency: string;

  addItem(productId: string, quantity?: number): Promise<void>;
  setQuantity(productId: string, quantity: number): Promise<void>;
  removeItem(productId: string): Promise<void>;
  clearCart(): Promise<void>;

  /**
   * For anonymous mode: snapshot a product into the guest cart. The product
   * card / detail page calls this as the "add" action — it doesn't hit the
   * network and works without a session.
   */
  addGuestItem(item: GuestCartItem): void;
}

const CartContext = createContext<CartContextValue | null>(null);

// ─── sessionStorage helpers ────────────────────────────────────────────────

function readGuestCart(): GuestCartItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(GUEST_CART_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // Light shape check — anything we don't recognise we drop. This prevents
    // a malformed entry (left over from an older code version) from poisoning
    // the cart for the rest of the session.
    return parsed.filter(isGuestCartItem);
  } catch {
    return [];
  }
}

function writeGuestCart(items: GuestCartItem[]): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(GUEST_CART_KEY, JSON.stringify(items));
  } catch {
    // Quota exceeded / sessionStorage disabled. The cart is ephemeral by
    // design — silently dropping is acceptable and matches the spec's stance
    // on guest carts being best-effort.
  }
}

function clearGuestCart(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(GUEST_CART_KEY);
  } catch {
    // Same rationale as writeGuestCart.
  }
}

function isGuestCartItem(v: unknown): v is GuestCartItem {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.productId === "string" &&
    typeof o.quantity === "number" &&
    o.quantity >= 1 &&
    typeof o.snapshot === "object" &&
    o.snapshot !== null
  );
}

/** Render a guest cart as CartLine[] for display. */
function guestCartToLines(items: GuestCartItem[]): CartLine[] {
  return items.map((g) => ({
    productId: g.productId,
    slug: g.snapshot.slug,
    code: g.snapshot.code,
    name: g.snapshot.name,
    priceCents: g.snapshot.priceCents,
    currency: g.snapshot.currency,
    stockStatus: g.snapshot.stockStatus,
    quantity: g.quantity,
    image: g.snapshot.image,
    addedAt: new Date(0).toISOString(), // ordering is insertion order, not addedAt
  }));
}

function deriveTotals(lines: CartLine[]): {
  itemCount: number;
  subtotalCents: number;
  currency: string;
} {
  const itemCount = lines.reduce((sum, l) => sum + l.quantity, 0);
  const subtotalCents = lines
    .filter((l) => l.stockStatus === "in_stock")
    .reduce((sum, l) => sum + l.priceCents * l.quantity, 0);
  const currency = lines[0]?.currency ?? "EUR";
  return { itemCount, subtotalCents, currency };
}

function clamp(n: number): number {
  return Math.max(1, Math.min(MAX_QUANTITY_PER_LINE, Math.floor(n)));
}

// ─── Provider ──────────────────────────────────────────────────────────────

export function CartProvider({ children }: { children: React.ReactNode }) {
  const { status: authStatus, isLoggedIn } = useAuth();
  const [items, setItems] = useState<CartLine[]>([]);
  const [status, setStatus] = useState<CartContextValue["status"]>("loading");
  const [lastError, setLastError] = useState<CartError | null>(null);

  // Track which auth status we last reacted to. When auth flips we trigger
  // the appropriate mode change (initial fetch, merge-on-login, drop-on-
  // logout). useRef avoids effects firing twice on the same status thanks
  // to React StrictMode in dev.
  const lastReactedAuthStatus = useRef<AuthStatus | null>(null);

  // ── Guest mode helpers ────────────────────────────────────────────────────
  const refreshGuestState = useCallback(() => {
    const guest = readGuestCart();
    setItems(guestCartToLines(guest));
    setStatus("ready");
    setLastError(null);
  }, []);

  // ── Server mode helpers ───────────────────────────────────────────────────
  const applyServerView = useCallback((view: CartView) => {
    setItems(view.items);
  }, []);

  const reloadServerCart = useCallback(async () => {
    setStatus("loading");
    const res = await fetchCart();
    if (res.ok) {
      applyServerView(res.value);
      setStatus("ready");
      setLastError(null);
    } else if (res.error.kind === "unauthenticated") {
      // Cookie expired between auth bootstrap and now — fall back to anon.
      setItems([]);
      setStatus("ready");
      setLastError(null);
    } else {
      setStatus("error");
      setLastError(res.error);
    }
  }, [applyServerView]);

  const mergeAndLoad = useCallback(
    async (guest: GuestCartItem[]) => {
      setStatus("loading");
      const payload = guest.map((g) => ({
        productId: g.productId,
        quantity: clamp(g.quantity),
      }));
      const res = await mergeCart(payload);
      // Whether merge succeeds or the user wasn't actually authed (rare race
      // with cookie expiry mid-merge), the guest cart has done its job. Drop
      // it so we never replay it.
      clearGuestCart();
      if (res.ok) {
        applyServerView(res.value);
        setStatus("ready");
        setLastError(null);
      } else if (res.error.kind === "unauthenticated") {
        setItems([]);
        setStatus("ready");
        setLastError(null);
      } else {
        // Merge failed for a non-auth reason. Best we can do: read whatever
        // server cart already exists, ignore the lost guest items. The user
        // can re-add anything important.
        await reloadServerCart();
      }
    },
    [applyServerView, reloadServerCart],
  );

  // ── Auth-driven mode switching ────────────────────────────────────────────
  //
  // The block-level lint suppression below is deliberate. `react-hooks/
  // set-state-in-effect` (new in React 19) flags this effect because every
  // branch eventually calls setState — `refreshGuestState()` repopulates
  // local state from sessionStorage, `mergeAndLoad()` and `reloadServerCart()`
  // both update items/status after their network calls. That's the canonical
  // "subscribe to external state changes" pattern useEffect was designed for
  // — the external state is the auth context's status, and we have to swap
  // between the guest sessionStorage cart and the server cart whenever auth
  // flips. The proper "fix" is a state-management library that owns this
  // transition (Zustand / TanStack Query); that's a separate slice. Until
  // then this is intentionally an effect, dedupes on identical status (see
  // `lastReactedAuthStatus` ref), and cannot cascade.
  //
  // We use eslint-disable / eslint-enable around the whole useEffect rather
  // than per-line disables because there are 3+ setState chain calls inside,
  // and we want any future call sites added to the same effect to be covered
  // by the same rationale automatically.
  /* eslint-disable react-hooks/set-state-in-effect -- bootstrap pattern, see comment block above */
  useEffect(() => {
    // We only react when authStatus actually changes from what we last saw.
    // Re-running on identical status would re-fetch the cart on every render.
    if (lastReactedAuthStatus.current === authStatus) return;
    const previous = lastReactedAuthStatus.current;
    lastReactedAuthStatus.current = authStatus;

    if (authStatus === "loading") {
      // Wait for auth to settle. Show whatever we already have (empty on
      // initial mount, which is correct).
      return;
    }

    if (authStatus === "anonymous") {
      // Logged out OR initial state-was-anonymous. Either way, render guest
      // cart from sessionStorage.
      refreshGuestState();
      return;
    }

    // authStatus === "authenticated"
    if (previous === "anonymous") {
      // Just logged in. If the guest cart had items, merge them. Otherwise
      // skip the merge call — saves a round-trip on the common "log in with
      // no guest cart" path.
      const guest = readGuestCart();
      if (guest.length > 0) {
        void mergeAndLoad(guest);
      } else {
        void reloadServerCart();
      }
    } else {
      // Initial bootstrap with an SSR-known authenticated user, or any
      // other path into authenticated. Just load.
      void reloadServerCart();
    }
  }, [authStatus, mergeAndLoad, reloadServerCart, refreshGuestState]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // ── Mutations ─────────────────────────────────────────────────────────────

  /**
   * In anonymous mode the call sites already have the snapshot (they're
   * adding a product card they're rendering), so addItem is wired through
   * addGuestItem on those code paths. The bare addItem(productId) here is
   * the right shape for AUTHENTICATED mode — server hydrates from productId.
   */
  const addItem = useCallback(
    async (productId: string, quantity = 1): Promise<void> => {
      const q = clamp(quantity);
      if (!isLoggedIn) {
        // Anonymous: this path is reached only if a caller doesn't have the
        // product snapshot. We can't render a meaningful guest line without
        // it, so this becomes a no-op. Callers should use addGuestItem.
        return;
      }
      setStatus("mutating");
      const res = await addCartItem(productId, q);
      if (res.ok) {
        applyServerView(res.value);
        setStatus("ready");
        setLastError(null);
      } else {
        setStatus("error");
        setLastError(res.error);
      }
    },
    [applyServerView, isLoggedIn],
  );

  const addGuestItem = useCallback(
    (item: GuestCartItem): void => {
      if (isLoggedIn) {
        // Logged in: ignore the snapshot and route through the server.
        // Fire-and-forget is fine for the optimistic-style UI.
        void addItem(item.productId, item.quantity);
        return;
      }
      const current = readGuestCart();
      const existing = current.find((c) => c.productId === item.productId);
      let next: GuestCartItem[];
      if (existing) {
        next = current.map((c) =>
          c.productId === item.productId
            ? {
                ...c,
                quantity: clamp(c.quantity + item.quantity),
                snapshot: item.snapshot, // refresh — catalog may have changed
              }
            : c,
        );
      } else {
        next = [...current, { ...item, quantity: clamp(item.quantity) }];
      }
      writeGuestCart(next);
      setItems(guestCartToLines(next));
      setStatus("ready");
      setLastError(null);
    },
    [addItem, isLoggedIn],
  );

  const setQuantity = useCallback(
    async (productId: string, quantity: number): Promise<void> => {
      const q = quantity <= 0 ? 0 : clamp(quantity);

      if (!isLoggedIn) {
        const current = readGuestCart();
        const next =
          q === 0
            ? current.filter((c) => c.productId !== productId)
            : current.map((c) =>
                c.productId === productId ? { ...c, quantity: q } : c,
              );
        writeGuestCart(next);
        setItems(guestCartToLines(next));
        setStatus("ready");
        setLastError(null);
        return;
      }

      // Authenticated: optimistic update with rollback. Server is the source
      // of truth either way — its response replaces local state on success.
      const before = items;
      const optimistic =
        q === 0
          ? items.filter((l) => l.productId !== productId)
          : items.map((l) =>
              l.productId === productId ? { ...l, quantity: q } : l,
            );
      setItems(optimistic);
      setStatus("mutating");

      const res =
        q === 0
          ? await removeCartItem(productId)
          : await setCartItemQuantity(productId, q);

      if (res.ok) {
        applyServerView(res.value);
        setStatus("ready");
        setLastError(null);
      } else {
        setItems(before);
        setStatus("error");
        setLastError(res.error);
      }
    },
    [applyServerView, isLoggedIn, items],
  );

  const removeItem = useCallback(
    async (productId: string): Promise<void> => {
      if (!isLoggedIn) {
        const next = readGuestCart().filter((c) => c.productId !== productId);
        writeGuestCart(next);
        setItems(guestCartToLines(next));
        setStatus("ready");
        setLastError(null);
        return;
      }

      const before = items;
      setItems(items.filter((l) => l.productId !== productId));
      setStatus("mutating");

      const res = await removeCartItem(productId);
      if (res.ok) {
        applyServerView(res.value);
        setStatus("ready");
        setLastError(null);
      } else {
        setItems(before);
        setStatus("error");
        setLastError(res.error);
      }
    },
    [applyServerView, isLoggedIn, items],
  );

  const clearCart = useCallback(async (): Promise<void> => {
    if (!isLoggedIn) {
      clearGuestCart();
      setItems([]);
      setStatus("ready");
      setLastError(null);
      return;
    }

    const before = items;
    setItems([]);
    setStatus("mutating");

    const res = await clearServerCart();
    if (res.ok) {
      applyServerView(res.value);
      setStatus("ready");
      setLastError(null);
    } else {
      setItems(before);
      setStatus("error");
      setLastError(res.error);
    }
  }, [applyServerView, isLoggedIn, items]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const totals = useMemo(() => deriveTotals(items), [items]);

  const value = useMemo<CartContextValue>(
    () => ({
      items,
      status,
      lastError,
      isAuthenticated: isLoggedIn,
      itemCount: totals.itemCount,
      subtotalCents: totals.subtotalCents,
      currency: totals.currency,
      addItem,
      addGuestItem,
      setQuantity,
      removeItem,
      clearCart,
    }),
    [
      items,
      status,
      lastError,
      isLoggedIn,
      totals,
      addItem,
      addGuestItem,
      setQuantity,
      removeItem,
      clearCart,
    ],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used within CartProvider");
  return ctx;
}

// Re-export the useful types so consumers can import from one place.
export type { CartLine, CartView, CartError, GuestCartItem, StockStatus };
