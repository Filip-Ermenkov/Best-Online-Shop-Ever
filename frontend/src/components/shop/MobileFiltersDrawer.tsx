"use client";

import { useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import ProductFilters from "@/components/shop/ProductFilters";

interface MobileFiltersDrawerProps {
  trigger: React.ReactNode;
  activeSort: string;
}

export default function MobileFiltersDrawer({
  trigger,
  activeSort,
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
          <ProductFilters activeSort={activeSort} />
        </SheetContent>
      </Sheet>
    </>
  );
}
