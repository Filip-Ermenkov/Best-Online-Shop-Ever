"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { X } from "lucide-react";

/**
 * Ephemeral "the page you came from was removed" notice — the spec's
 * (`docs/README.md` §"Пренасочване при изтрит ресурс") toast shown after a 301
 * from a deleted category/product URL to its surviving target.
 *
 * **Why a URL fragment (`#moved`), not a `?query=` param.** The storefront's
 * other post-action notices use `?confirm=1` (e.g. the order page) — but those
 * are noindex account pages where a query param is harmless. A deleted-resource
 * 301 lands on an INDEXABLE catalog page, so a query param would give crawlers a
 * second URL to reconcile. A fragment is never sent to the server and is ignored
 * by crawlers, so the 301 target stays canonically clean while humans still get
 * the notice. The products catch-all appends `#moved` to the redirect target.
 *
 * **Why `useSyncExternalStore`.** Mirrors `CookieBanner`: it derives visibility
 * from an external value (the URL fragment) without a `setState` in an effect
 * body (which the project's react-hooks lint rule forbids). `getServerSnapshot`
 * returns `false` so SSR emits nothing and there is no hydration flash.
 */

function subscribeHash(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}
function getHashSnapshot(): boolean {
  return window.location.hash === "#moved";
}
function getHashServerSnapshot(): boolean {
  return false;
}

export default function MovedNotice() {
  const movedInUrl = useSyncExternalStore(
    subscribeHash,
    getHashSnapshot,
    getHashServerSnapshot,
  );
  const [dismissed, setDismissed] = useState(false);
  const visible = movedInUrl && !dismissed;

  // When the notice becomes relevant: strip the fragment (a DOM call, not
  // setState — effect-safe) so a refresh / shared link never re-triggers it and
  // the canonical URL stays clean, and auto-dismiss after a few seconds (the
  // setState runs in the timer callback, not synchronously in the effect body).
  useEffect(() => {
    if (!movedInUrl) return;
    history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
    const timer = window.setTimeout(() => setDismissed(true), 8000);
    return () => window.clearTimeout(timer);
  }, [movedInUrl]);

  if (!visible) return null;

  return (
    <div className="fixed bottom-4 left-4 z-40 max-w-sm pointer-events-none">
      <div
        role="status"
        aria-live="polite"
        className="flex items-start gap-3 bg-white border border-border rounded-xl shadow-2xl p-4 pointer-events-auto"
      >
        <p className="text-sm text-foreground">
          Търсеният продукт или категория вече не е наличен. Пренасочихме Ви към
          подходяща страница.
        </p>
        <button
          onClick={() => setDismissed(true)}
          className="shrink-0 text-muted-foreground hover:text-foreground"
          aria-label="Затвори съобщението"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
