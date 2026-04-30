"use client";

import { useState } from "react";
import { banners as initialBanners } from "@/lib/mock-data/banners";
import { Banner } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, Eye, EyeOff } from "lucide-react";

export default function AdminBannersPage() {
  const [bannerList, setBannerList] = useState<Banner[]>(initialBanners);

  function toggleActive(id: string) {
    setBannerList((list) =>
      list.map((b) => (b.id === id ? { ...b, isActive: !b.isActive } : b))
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Банери</h1>
        <Button className="gap-2">
          <Plus className="w-4 h-4" /> Добави банер
        </Button>
      </div>

      <div className="grid gap-4">
        {bannerList.map((b) => (
          <div key={b.id} className="rounded-lg border border-border bg-white p-4">
            {/* Desktop row / Mobile stack */}
            <div className="flex flex-col sm:flex-row sm:items-center gap-4">
              <div className="w-full sm:w-32 h-32 sm:h-16 rounded bg-muted overflow-hidden flex-shrink-0">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={b.imageUrl} alt={b.title} className="w-full h-full object-cover" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold">{b.title}</p>
                {b.subtitle && <p className="text-sm text-muted-foreground">{b.subtitle}</p>}
                {b.linkUrl && <p className="text-xs text-primary truncate">{b.linkUrl}</p>}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline" className={b.isActive ? "bg-green-50 text-green-700 border-green-200" : ""}>
                  {b.isActive ? "Активен" : "Скрит"}
                </Badge>
                <Button
                  variant="outline" size="sm"
                  onClick={() => toggleActive(b.id)}
                  className="gap-1.5"
                >
                  {b.isActive ? <><EyeOff className="w-3.5 h-3.5" /> Скрий</> : <><Eye className="w-3.5 h-3.5" /> Покажи</>}
                </Button>
                <Button variant="outline" size="sm">Редактирай</Button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
