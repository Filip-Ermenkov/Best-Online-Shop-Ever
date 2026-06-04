/**
 * Browser-side cookie-consent client.
 *
 * Same transport posture as lib/addresses/client.ts: every call hits
 * NEXT_PUBLIC_SHOP_API_URL with `credentials: "include"` so the strictly-
 * necessary `visitor_id` cookie the route mints rides along (and is received)
 * on subsequent calls. Plain `fetch` with the concrete `ConsentReceipt` /
 * `ConsentState` DTOs from `@shop/api`.
 *
 * BEST-EFFORT BY DESIGN. The consent banner's visibility is driven by
 * localStorage (see CookieBanner.tsx); the server receipt is the durable,
 * demonstrable record (GDPR Art. 7(1)) layered on top. These functions never
 * throw — a network failure must not break the banner UX or block the click.
 */
import type { ConsentCategory, ConsentReceipt, ConsentState } from "./types";

const baseUrl =
  process.env.NEXT_PUBLIC_SHOP_API_URL?.replace(/\/+$/, "") ??
  "http://localhost:3001";

/**
 * Record this visitor's choice server-side. Returns the receipt on success, or
 * `null` if the call failed for any reason (offline, 4xx/5xx, parse error).
 * `keepalive` lets the request survive a navigation triggered right after the
 * click (e.g. the visitor accepts, then immediately clicks a link).
 */
export async function recordConsent(
  acceptedCategories: ConsentCategory[],
): Promise<ConsentReceipt | null> {
  try {
    const res = await fetch(`${baseUrl}/consent`, {
      method: "POST",
      credentials: "include",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ acceptedCategories }),
    });
    if (!res.ok) return null;
    return (await res.json()) as ConsentReceipt;
  } catch {
    return null;
  }
}

/**
 * Read the visitor's current (latest) receipt, or `{ consent: null }` if this
 * browser has never recorded a choice. Read-only: never mints an identifier.
 */
export async function getConsent(): Promise<ConsentState> {
  try {
    const res = await fetch(`${baseUrl}/consent`, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return { consent: null };
    return (await res.json()) as ConsentState;
  } catch {
    return { consent: null };
  }
}
