"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { X } from "lucide-react";

type CookiePrefs = { functional: boolean; analytics: boolean };

const STORAGE_KEY = "cookie_consent";

/**
 * Subscribe to the consent record in localStorage.
 *
 * Why useSyncExternalStore (not useEffect-on-mount + useState):
 *   • The render-time derivation `stored === null ⇒ show banner` keeps
 *     visibility out of effects — no `setState-in-effect` warning, no
 *     extra render after mount.
 *   • The `subscribe` callback wires up two events:
 *       - `storage` — fires in OTHER tabs when localStorage changes. Lets
 *         a customer who accepts in one tab see the banner disappear in
 *         the other tab automatically.
 *       - A custom `CONSENT_CHANGED_EVENT` we dispatch from `writeConsent`
 *         below. Required because the `storage` event explicitly does NOT
 *         fire in the *same* tab that wrote the value (per HTML spec
 *         §9.4) — without this, clicking "Accept all" wouldn't hide the
 *         banner until a re-mount.
 *   • `getServerSnapshot` returns "" (empty string, NOT null), so the SSR
 *     pass's `stored === null` check evaluates false and the server emits
 *     no banner markup. Avoids the SSR-flash where the banner appears for
 *     one frame before hydration corrects it.
 */
const CONSENT_CHANGED_EVENT = "shop:cookie-consent-changed";

function subscribeConsent(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", callback);
  window.addEventListener(CONSENT_CHANGED_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(CONSENT_CHANGED_EVENT, callback);
  };
}
function getConsentSnapshot(): string | null {
  return localStorage.getItem(STORAGE_KEY);
}
function getConsentServerSnapshot(): string {
  return ""; // sentinel: SSR treats consent as "given" so the banner stays hidden
}
function writeConsent(value: object): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  // Notify the in-tab subscribers — `storage` events don't fire here.
  window.dispatchEvent(new Event(CONSENT_CHANGED_EVENT));
}

export default function CookieBanner() {
  const stored = useSyncExternalStore(
    subscribeConsent,
    getConsentSnapshot,
    getConsentServerSnapshot,
  );
  const visible = stored === null;

  const [showDetails, setShowDetails] = useState(false);
  const [prefs, setPrefs] = useState<CookiePrefs>({ functional: false, analytics: false });

  function acceptAll() {
    writeConsent({ essential: true, functional: true, analytics: true });
  }

  function rejectAll() {
    writeConsent({ essential: true, functional: false, analytics: false });
  }

  function savePrefs() {
    writeConsent({ essential: true, ...prefs });
  }

  if (!visible) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 p-4 pointer-events-none">
      <div className="max-w-2xl mx-auto bg-white border border-border rounded-xl shadow-2xl p-5 pointer-events-auto">
        <div className="flex items-start justify-between gap-3 mb-3">
          <h3 className="font-semibold">Използваме бисквитки</h3>
          <button onClick={rejectAll} className="text-muted-foreground hover:text-foreground" aria-label="Откажи">
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-sm text-muted-foreground mb-4">
          Използваме бисквитки за нормалното функциониране на сайта и с ваше съгласие — за подобряване на
          услугите и анализ. Научете повече в нашата{" "}
          <Link href="/privacy" className="text-primary hover:underline">Политика за поверителност</Link>.
        </p>

        {showDetails && (
          <div className="mb-4 space-y-3 rounded-lg bg-muted/50 p-4">
            <div className="flex items-start gap-3">
              <Checkbox id="essential" checked disabled />
              <div>
                <Label htmlFor="essential" className="font-medium">Задължителни</Label>
                <p className="text-xs text-muted-foreground">Необходими за функционирането на сайта. Не могат да бъдат изключени.</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Checkbox
                id="functional"
                checked={prefs.functional}
                onCheckedChange={(v) => setPrefs((p) => ({ ...p, functional: !!v }))}
              />
              <div>
                <Label htmlFor="functional" className="font-medium">Функционални</Label>
                <p className="text-xs text-muted-foreground">Запомнят предпочитания (напр. език, запазена количка).</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Checkbox
                id="analytics"
                checked={prefs.analytics}
                onCheckedChange={(v) => setPrefs((p) => ({ ...p, analytics: !!v }))}
              />
              <div>
                <Label htmlFor="analytics" className="font-medium">Аналитични</Label>
                <p className="text-xs text-muted-foreground">Помагат ни да разберем как се използва сайтът (анонимно).</p>
              </div>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2 justify-end">
          <Button variant="ghost" size="sm" onClick={() => setShowDetails((v) => !v)}>
            {showDetails ? "Скрий настройките" : "Персонализирай"}
          </Button>
          {showDetails && (
            <Button variant="outline" size="sm" onClick={savePrefs}>Запази избора</Button>
          )}
          <Button variant="outline" size="sm" onClick={rejectAll}>Само задължителни</Button>
          <Button size="sm" onClick={acceptAll}>Приемам всички</Button>
        </div>
      </div>
    </div>
  );
}
