"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { X } from "lucide-react";

type CookiePrefs = { functional: boolean; analytics: boolean };

const STORAGE_KEY = "cookie_consent";

export default function CookieBanner() {
  const [visible, setVisible] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [prefs, setPrefs] = useState<CookiePrefs>({ functional: false, analytics: false });

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) setVisible(true);
  }, []);

  function acceptAll() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ essential: true, functional: true, analytics: true }));
    setVisible(false);
  }

  function rejectAll() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ essential: true, functional: false, analytics: false }));
    setVisible(false);
  }

  function savePrefs() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ essential: true, ...prefs }));
    setVisible(false);
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
