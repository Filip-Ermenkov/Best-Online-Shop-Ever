import { Suspense } from "react";
import ProductEditor from "@/components/admin/ProductEditor";

/**
 * Edit a product — real `/admin/products/:id` GET/PATCH/DELETE/restore via
 * ProductEditor (the page sits behind the AdminAuthGate rendered by
 * app/admin/layout.tsx). The editor uses `useSearchParams`, so it sits inside a
 * Suspense boundary.
 */
export default async function AdminEditProductPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <Suspense fallback={<div className="max-w-2xl h-64" aria-hidden="true" />}>
      <ProductEditor mode="edit" productId={id} />
    </Suspense>
  );
}
