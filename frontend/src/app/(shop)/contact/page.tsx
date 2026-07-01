"use client";

import { useEffect, useState } from "react";
import { MapPin, Phone, Mail, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { fetchPublicSettings } from "@/lib/api";
import type { PublicSettings } from "@shop/api";

// Static fallbacks shown until the live settings load (and if the API blips).
const FALLBACK = {
  storeAddress: "ул. Витоша 15, София 1000, България",
  storePhone: "+359 2 900 1234",
  storeEmail: "info@duda1.bg",
  storeHours: "Пн–Пт: 9:00–18:00\nСъб: 10:00–14:00",
};

export default function ContactPage() {
  const [form, setForm] = useState({ name: "", email: "", subject: "", message: "" });
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [settings, setSettings] = useState<PublicSettings | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = await fetchPublicSettings({ cache: "no-store" });
      if (!cancelled && s) setSettings(s);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Live value if the admin configured one; otherwise the static fallback.
  const pick = (k: keyof typeof FALLBACK): string => {
    const v = settings?.[k];
    return v && v.trim().length > 0 ? v : FALLBACK[k];
  };

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    await new Promise((r) => setTimeout(r, 1000));
    setLoading(false);
    setSent(true);
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-12">
      <h1 className="text-3xl font-bold mb-2">Контакти</h1>
      <p className="text-muted-foreground mb-10">Имате въпрос? Ще се радваме да чуем от вас.</p>

      <div className="grid md:grid-cols-[1fr_320px] gap-10">
        {/* Contact form */}
        <div>
          {sent ? (
            <div className="rounded-lg border border-green-200 bg-green-50 p-8 text-center space-y-2">
              <p className="font-bold text-green-700 text-lg">Съобщението е изпратено!</p>
              <p className="text-sm text-green-700">Ще се свържем с вас в рамките на 1 работен ден.</p>
              <button onClick={() => setSent(false)} className="text-sm text-primary-strong underline mt-2">
                Изпрати ново съобщение
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="name">Вашето име</Label>
                  <Input id="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required className="mt-1" />
                </div>
                <div>
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required className="mt-1" />
                </div>
              </div>
              <div>
                <Label htmlFor="subject">Тема</Label>
                <Input id="subject" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} required className="mt-1" placeholder="Въпрос за поръчка / Рекламация / Друго" />
              </div>
              <div>
                <Label htmlFor="message">Съобщение</Label>
                <Textarea id="message" value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} required rows={5} className="mt-1 resize-none" />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "Изпращане..." : "Изпрати съобщение"}
              </Button>
            </form>
          )}
        </div>

        {/* Contact info */}
        <div className="space-y-5">
          <div className="rounded-lg border border-border bg-card p-5 space-y-4">
            <h2 className="font-semibold">Информация за контакт</h2>
            {[
              { icon: MapPin, label: "Адрес", value: pick("storeAddress") },
              { icon: Phone, label: "Телефон", value: pick("storePhone") },
              { icon: Mail, label: "Email", value: pick("storeEmail") },
              { icon: Clock, label: "Работно време", value: pick("storeHours") },
            ].map(({ icon: Icon, label, value }) => (
              <div key={label} className="flex gap-3">
                <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <Icon className="w-4 h-4 text-primary-strong" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="text-sm font-medium whitespace-pre-line">{value}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
