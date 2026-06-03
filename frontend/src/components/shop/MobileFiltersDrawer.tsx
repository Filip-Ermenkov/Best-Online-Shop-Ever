"use client";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import ProductFilters from "@/components/shop/ProductFilters";

interface MobileFiltersDrawerProps {
  /**
   * The element that opens the drawer (e.g. a button). base-ui's
   * `SheetTrigger render={trigger}` clones it and wires `onClick` +
   * `aria-haspopup="dialog"` + `aria-expanded` onto it, so the trigger must
   * forward props to a real DOM element. Replaces the previous
   * `<span onClick>` wrapper, which was a non-interactive element carrying a
   * click handler with no keyboard or ARIA semantics (WCAG 2.1.1 / 4.1.2).
   */
  trigger: React.ReactElement;
  activeSort: string;
}

export default function MobileFiltersDrawer({
  trigger,
  activeSort,
}: MobileFiltersDrawerProps) {
  return (
    <Sheet>
      <SheetTrigger render={trigger} />
      <SheetContent side="left" className="w-72 overflow-y-auto px-4">
        <SheetHeader className="mb-4 px-0">
          <SheetTitle>Филтри</SheetTitle>
        </SheetHeader>
        <ProductFilters activeSort={activeSort} />
      </SheetContent>
    </Sheet>
  );
}
