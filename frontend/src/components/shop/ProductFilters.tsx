"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { CategoryNode } from "@/lib/types";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

interface ProductFiltersProps {
  category: CategoryNode;
  activeSort: string;
  priceMin: number;
  priceMax: number;
}

const sortOptions = [
  { value: "default", label: "По подразбиране" },
  { value: "price_asc", label: "Цена: ниска → висока" },
  { value: "price_desc", label: "Цена: висока → ниска" },
  { value: "newest", label: "Най-нови" },
  { value: "name_asc", label: "По азбучен ред" },
];

export default function ProductFilters({ category, activeSort, priceMin, priceMax }: ProductFiltersProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function setParam(key: string, value: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === null || value === "default") {
      params.delete(key);
    } else {
      params.set(key, value);
    }
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  return (
    <div className="space-y-5 px-1">
      {/* Sort */}
      <div>
        <h3 className="font-semibold text-sm mb-2">Сортиране</h3>
        <ul className="space-y-1">
          {sortOptions.map((opt) => (
            <li key={opt.value}>
              <button
                onClick={() => setParam("sort", opt.value)}
                className={cn(
                  "text-sm w-full text-left px-2 py-1 rounded hover:bg-muted transition-colors",
                  activeSort === opt.value && "font-semibold text-primary"
                )}
              >
                {opt.label}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <Separator />

      {/* Price info */}
      <div>
        <h3 className="font-semibold text-sm mb-1">Ценови диапазон</h3>
        <p className="text-xs text-muted-foreground">
          {priceMin} EUR – {priceMax} EUR
        </p>
      </div>
    </div>
  );
}
