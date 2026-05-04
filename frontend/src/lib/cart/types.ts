/**
 * Shared cart types.
 *
 * The "wire" types match the API's CartView / CartLine — no transformation
 * happens in the client; the API response IS the rendered cart shape. The UI
 * works in EUR cents throughout (priceCents, subtotalCents) because that's
 * what the spec stores, and converting once at the rendering edge avoids
 * floating-point drift across reducers.
 *
 * Hard cap mirrored from the server (cart.ts MAX_QUANTITY_PER_LINE) so the
 * UI can prevent obviously-bogus increments without round-tripping. The
 * server is the source of truth — it will clamp anything that slips through.
 */

export const MAX_QUANTITY_PER_LINE = 99;

export type StockStatus = "in_stock" | "out_of_stock";

export interface CartLine {
  productId: string;
  slug: string;
  code: string;
  name: string;
  /** Current live price in EUR cents — refetched on every read. */
  priceCents: number;
  currency: string;
  stockStatus: StockStatus;
  quantity: number;
  image: { url: string; alt: string } | null;
  addedAt: string;
}

export interface CartView {
  items: CartLine[];
  /** EUR cents, in-stock lines only. */
  subtotalCents: number;
  /** Sum of all quantities, including out-of-stock lines. */
  itemCount: number;
  currency: string;
  updatedAt: string;
}

/**
 * Discriminated error union for the UI to switch on.
 *
 *   - validation:        backend rejected the request body (RFC 9457 errors).
 *   - unauthenticated:   no/expired session — UI should bounce to login.
 *   - not_found:         product or line vanished (race with delete/archive).
 *   - out_of_stock:      tried to add an item the catalog marked unavailable.
 *   - network:           fetch threw (offline, DNS, etc.).
 *   - unknown:           anything else — display a generic toast.
 */
export type CartError =
  | { kind: "validation"; fields: { path: string; message: string }[]; detail?: string }
  | { kind: "unauthenticated"; detail?: string }
  | { kind: "not_found"; detail?: string }
  | { kind: "out_of_stock"; detail?: string }
  | { kind: "network"; cause?: unknown }
  | { kind: "unknown"; status: number; detail?: string };

export type CartResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: CartError };

/**
 * Shape persisted to sessionStorage for the anonymous (guest) cart. Lean —
 * just productId + quantity + a fingerprint of what the catalog showed at
 * add time, so an offline render can show the row without network.
 *
 * On login this is collapsed to {productId, quantity}[] for POST /cart/merge.
 * Hydration after merge always comes from the server, so the snapshot fields
 * may be stale — they exist only to render the guest cart pre-login.
 */
export interface GuestCartItem {
  productId: string;
  quantity: number;
  /** UI-only snapshot. Server is source of truth post-login. */
  snapshot: {
    slug: string;
    code: string;
    name: string;
    priceCents: number;
    currency: string;
    stockStatus: StockStatus;
    image: { url: string; alt: string } | null;
  };
}
