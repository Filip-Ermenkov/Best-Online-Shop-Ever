"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Plus, X, Check, GripVertical, ImagePlus } from "lucide-react";
import { flattenCategories } from "@/lib/mock-data/categories";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { cn, sanitizeImageUrl } from "@/lib/utils";

interface VariantOption { label: string; available: boolean; imageUrl: string; }
interface Variant { name: string; options: VariantOption[]; }

export default function AdminNewProductPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const preselectedCategoryId = searchParams.get("categoryId") ?? "";
  const [saved, setSaved] = useState(false);
  const [form, setForm] = useState({
    name: "", code: "", price: "", description: "",
    categoryId: preselectedCategoryId, stockStatus: "in_stock",
    isNew: false,
  });
  const [imageUrls, setImageUrls] = useState<string[]>([""]);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [newVariantName, setNewVariantName] = useState("");

  const allCategories = flattenCategories();

  function setField(key: keyof typeof form, value: string | boolean) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  // ── Image management ──
  function addImageSlot() { setImageUrls((u) => [...u, ""]); }
  function updateImageUrl(i: number, url: string) { setImageUrls((u) => u.map((v, j) => j === i ? url : v)); }
  function removeImageSlot(i: number) { setImageUrls((u) => u.filter((_, j) => j !== i)); }

  // ── Variant management ──
  function addVariant() {
    if (!newVariantName.trim()) return;
    setVariants((v) => [...v, { name: newVariantName.trim(), options: [] }]);
    setNewVariantName("");
  }
  function removeVariant(i: number) { setVariants((v) => v.filter((_, idx) => idx !== i)); }
  function addOption(variantIdx: number) {
    const label = prompt("Опция (напр. Черен):");
    if (!label?.trim()) return;
    setVariants((v) => v.map((variant, i) =>
      i === variantIdx ? { ...variant, options: [...variant.options, { label: label.trim(), available: true, imageUrl: "" }] } : variant
    ));
  }
  function toggleOptionAvailability(vi: number, oi: number) {
    setVariants((v) => v.map((variant, i) =>
      i === vi ? { ...variant, options: variant.options.map((opt, j) => j === oi ? { ...opt, available: !opt.available } : opt) } : variant
    ));
  }
  function updateOptionImage(vi: number, oi: number, url: string) {
    setVariants((v) => v.map((variant, i) =>
      i === vi ? { ...variant, options: variant.options.map((opt, j) => j === oi ? { ...opt, imageUrl: url } : opt) } : variant
    ));
  }
  function removeOption(vi: number, oi: number) {
    setVariants((v) => v.map((variant, i) =>
      i === vi ? { ...variant, options: variant.options.filter((_, j) => j !== oi) } : variant
    ));
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    await new Promise((r) => setTimeout(r, 700));
    setSaved(true);
    setTimeout(() => { setSaved(false); router.push("/admin/products"); }, 1500);
  }

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-3 mb-6">
        <ButtonLink variant="ghost" size="sm" href="/admin/products" className="gap-1">
          <ArrowLeft className="w-4 h-4" /> Назад
        </ButtonLink>
        <h1 className="text-2xl font-bold">Нов продукт</h1>
      </div>

      <form onSubmit={handleSave} className="space-y-6">
        {/* Basic info */}
        <section className="rounded-lg border border-border bg-card p-5 space-y-4">
          <h2 className="font-semibold">Основна информация</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <Label htmlFor="name">Наименование</Label>
              <Input id="name" value={form.name} onChange={(e) => setField("name", e.target.value)} required className="mt-1" />
            </div>
            <div>
              <Label htmlFor="code">Продуктов код</Label>
              <Input id="code" value={form.code} onChange={(e) => setField("code", e.target.value)} required className="mt-1" placeholder="EL-PH-003" />
            </div>
            <div>
              <Label htmlFor="price">Цена (EUR)</Label>
              <Input id="price" type="number" min="0" step="0.01" value={form.price} onChange={(e) => setField("price", e.target.value)} required className="mt-1" />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="description">Описание</Label>
              <Textarea id="description" value={form.description} onChange={(e) => setField("description", e.target.value)} rows={3} className="mt-1 resize-none" />
            </div>
          </div>
        </section>

        {/* Category — flat list with indentation showing depth */}
        <section className="rounded-lg border border-border bg-card p-5 space-y-4">
          <h2 className="font-semibold">Категория</h2>
          <div>
            <Label htmlFor="category">Категория (на всяко ниво)</Label>
            <select
              id="category"
              value={form.categoryId}
              onChange={(e) => setField("categoryId", e.target.value)}
              required
              className="mt-1 w-full text-sm border border-input rounded-md px-3 py-2 bg-background focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">Избери...</option>
              {allCategories.map((c) => {
                const depth = getNodeDepth(c, allCategories);
                return (
                  <option key={c.id} value={c.id}>
                    {"—".repeat(depth)} {c.name}
                  </option>
                );
              })}
            </select>
          </div>
        </section>

        {/* Stock + flags */}
        <section className="rounded-lg border border-border bg-card p-5 space-y-4">
          <h2 className="font-semibold">Наличност</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-center">
            <div>
              <Label htmlFor="stockStatus">Статус</Label>
              <select
                id="stockStatus"
                value={form.stockStatus}
                onChange={(e) => setField("stockStatus", e.target.value)}
                className="mt-1 w-full text-sm border border-input rounded-md px-3 py-2 bg-background focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="in_stock">В наличност</option>
                <option value="out_of_stock">Изчерпано</option>
              </select>
            </div>
            <div className="flex items-center gap-2 sm:pt-6">
              <input
                type="checkbox"
                id="isNew"
                checked={form.isNew as boolean}
                onChange={(e) => setField("isNew", e.target.checked)}
                className="w-4 h-4 rounded border-input accent-primary"
              />
              <Label htmlFor="isNew">Маркирай като НОВО</Label>
            </div>
          </div>
        </section>

        {/* Multiple images */}
        <section className="rounded-lg border border-border bg-card p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Снимки</h2>
            <Button type="button" variant="outline" size="sm" onClick={addImageSlot} className="gap-1">
              <ImagePlus className="w-4 h-4" /> Добави снимка
            </Button>
          </div>
          <div className="space-y-3">
            {imageUrls.map((url, i) => (
              <div key={i} className="flex items-start gap-2">
                <div className="flex items-center gap-1 text-muted-foreground pt-2">
                  <GripVertical className="w-4 h-4" />
                  <span className="text-xs w-4">{i + 1}.</span>
                </div>
                <div className="flex-1 space-y-1">
                  <Input
                    type="url" placeholder="https://..."
                    value={url}
                    onChange={(e) => updateImageUrl(i, e.target.value)}
                  />
                  {/* Render the preview only when the URL parses cleanly
                     as http/https — blocks javascript:/data:/vbscript:
                     URL XSS sinks. We bind the SANITIZER'S RETURN VALUE
                     (the canonicalized `new URL(...).toString()` string)
                     to <img src>, not the raw `url` variable, so SAST
                     taint trackers see "value originates from a trusted
                     URL constructor" rather than "user input flows into
                     a DOM sink". This is what closes the "DOM text
                     reinterpreted as HTML" / "Client-side XSS" alert
                     classes across CodeQL / Snyk / Semgrep. */}
                  {(() => {
                    const safeSrc = sanitizeImageUrl(url);
                    if (!safeSrc) return null;
                    return (
                      <div className="w-16 h-16 rounded border border-border overflow-hidden bg-muted">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={safeSrc} alt={`Снимка ${i + 1}`} className="w-full h-full object-cover" />
                      </div>
                    );
                  })()}
                </div>
                {imageUrls.length > 1 && (
                  <button type="button" onClick={() => removeImageSlot(i)} className="pt-2 text-muted-foreground hover:text-destructive">
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* Variants with images per option */}
        <section className="rounded-lg border border-border bg-card p-5 space-y-4">
          <h2 className="font-semibold">Варианти (опционално)</h2>
          {variants.map((variant, vi) => (
            <div key={vi} className="border border-border rounded-md p-3 space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-medium text-sm">{variant.name}</span>
                <button type="button" onClick={() => removeVariant(vi)} className="text-muted-foreground hover:text-destructive transition-colors">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="space-y-2">
                {variant.options.map((opt, oi) => (
                  <div key={oi} className="flex items-center gap-2 flex-wrap">
                    <button
                      type="button"
                      onClick={() => toggleOptionAvailability(vi, oi)}
                      className={cn(
                        "px-2.5 py-1 text-xs rounded-md border transition-colors",
                        opt.available ? "border-primary/60 bg-primary/5" : "border-border opacity-50 line-through"
                      )}
                    >
                      {opt.label}
                    </button>
                    <Input
                      type="url" placeholder="Снимка URL (опционално)"
                      value={opt.imageUrl}
                      onChange={(e) => updateOptionImage(vi, oi, e.target.value)}
                      className="flex-1 min-w-[140px] h-7 text-xs"
                    />
                    {/* Same sanitizer-by-transformation pattern as the
                       main product image preview above — bind the
                       sanitized return value, not the raw input, so
                       SAST taint tracking sees a trusted source. */}
                    {(() => {
                      const safeSrc = sanitizeImageUrl(opt.imageUrl);
                      if (!safeSrc) return null;
                      return (
                        <div className="w-7 h-7 rounded border border-border overflow-hidden bg-muted flex-shrink-0">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={safeSrc} alt={opt.label} className="w-full h-full object-cover" />
                        </div>
                      );
                    })()}
                    <button type="button" onClick={() => removeOption(vi, oi)} className="text-muted-foreground hover:text-destructive">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={() => addOption(vi)}
                className="px-2.5 py-1 text-xs rounded-md border border-dashed border-border hover:border-primary/60 transition-colors text-muted-foreground"
              >
                + Добави опция
              </button>
            </div>
          ))}
          <div className="flex gap-2">
            <Input
              placeholder="Наименование на вариант (напр. Цвят)"
              value={newVariantName}
              onChange={(e) => setNewVariantName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addVariant())}
              className="flex-1"
            />
            <Button type="button" variant="outline" onClick={addVariant} className="gap-1">
              <Plus className="w-4 h-4" /> Добави
            </Button>
          </div>
        </section>

        <Separator />

        <div className="flex gap-3">
          <ButtonLink variant="outline" href="/admin/products">Откажи</ButtonLink>
          <Button type="submit" className="flex-1 gap-2" disabled={saved}>
            {saved ? <><Check className="w-4 h-4" /> Запазено!</> : "Запази продукта"}
          </Button>
        </div>
      </form>
    </div>
  );
}

/** Calculate depth of a category node */
function getNodeDepth(node: { parentId: string | null }, all: { id: string; parentId: string | null }[]): number {
  let depth = 0;
  let current = node;
  while (current.parentId) {
    depth++;
    const parent = all.find((c) => c.id === current.parentId);
    if (!parent) break;
    current = parent;
  }
  return depth;
}
