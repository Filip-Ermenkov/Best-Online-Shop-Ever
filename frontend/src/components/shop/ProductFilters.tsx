"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * Sort options exposed in the storefront filter UI. The `value` is the same
 * string the API's `/products?sort=...` accepts — see
 * `backend/shop-api/src/routes/products.ts` `SortKey`. Keep this list in sync
 * with the server's enum; adding a sort here without adding it server-side
 * would just degrade to "featured" without a clear signal.
 *
 * "default" is rendered as a UI synonym for "featured" — the API's default
 * sort. We translate it at the page level when reading searchParams.
 */
const sortOptions = [
  { value: "default", label: "По подразбиране" },
  { value: "newest", label: "Най-нови" },
  { value: "price_asc", label: "Цена: ниска → висока" },
  { value: "price_desc", label: "Цена: висока → ниска" },
] as const;

export type SortValue = (typeof sortOptions)[number]["value"];

interface ProductFiltersProps {
  activeSort: string;
}

export default function ProductFilters({ activeSort }: ProductFiltersProps) {
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
      <div>
        <h3 className="font-semibold text-sm mb-2">Сортиране</h3>
        <ul className="space-y-1">
          {sortOptions.map((opt) => (
            <li key={opt.value}>
              <button
                onClick={() => setParam("sort", opt.value)}
                className={cn(
                  "text-sm w-full text-left px-2 py-1 rounded hover:bg-muted transition-colors",
                  activeSort === opt.value && "font-semibold text-primary",
                )}
              >
                {opt.label}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
