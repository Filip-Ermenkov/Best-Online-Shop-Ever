import ProductsManager from "@/components/admin/ProductsManager";

/**
 * Admin products list — real data via the `/admin/products` API (the page sits
 * behind the AdminAuthGate rendered by app/admin/layout.tsx). All the
 * interactivity lives in components/admin/ProductsManager (jsx-a11y-linted).
 */
export default function AdminProductsPage() {
  return <ProductsManager />;
}
