import { Suspense } from "react";
import ProductEditor from "@/components/admin/ProductEditor";

/**
 * Create a product — real `/admin/products` POST via ProductEditor (the page
 * sits behind the AdminAuthGate rendered by app/admin/layout.tsx). The editor
 * reads an optional `?categoryId=` to preselect the category, so it must sit
 * inside a Suspense boundary (`useSearchParams`).
 */
export default function AdminNewProductPage() {
  return (
    <Suspense fallback={<div className="max-w-2xl h-64" aria-hidden="true" />}>
      <ProductEditor mode="create" />
    </Suspense>
  );
}
