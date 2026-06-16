import type { Metadata } from "next";
import { FindOrderForm } from "@/components/shop/FindOrderForm";

/**
 * "Намери поръчката ми" — the lost-tracking-link recovery page for guests
 * (`docs/README.md` §7). The guest enters their order number + email; if they
 * match a guest order, the API re-sends the tracking link. The response is
 * always neutral (enumeration-resistant), so this page never confirms whether
 * an order or email exists.
 */
export const metadata: Metadata = {
  title: "Намери поръчката ми",
};

export default function FindOrderPage() {
  return (
    <div className="max-w-md mx-auto px-4 py-10">
      <h1 className="text-2xl font-semibold mb-2">Намери поръчката ми</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Изгубихте линка за проследяване? Въведете номера на поръчката и имейла, с
        който я направихте, и ще Ви изпратим линка отново.
      </p>
      <FindOrderForm />
    </div>
  );
}
