"use client";

import { useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import ProductFilters from "@/components/shop/ProductFilters";
import { CategoryNode } from "@/lib/types";

interface MobileFiltersDrawerProps {
  trigger: React.ReactNode;
  category: CategoryNode;
  activeSort: string;
  priceMin: number;
  priceMax: number;
}

export default function MobileFiltersDrawer({
  trigger, category, activeSort, priceMin, priceMax,
}: MobileFiltersDrawerProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <span onClick={() => setOpen(true)}>{trigger}</span>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-72 overflow-y-auto px-4">
          <SheetHeader className="mb-4 px-0">
            <SheetTitle>Филтри</SheetTitle>
          </SheetHeader>
          <ProductFilters
            category={category}
            activeSort={activeSort}
            priceMin={priceMin}
            priceMax={priceMax}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}
