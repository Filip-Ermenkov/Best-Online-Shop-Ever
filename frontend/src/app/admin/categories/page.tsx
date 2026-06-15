import CategoriesManager from "@/components/admin/CategoriesManager";

/**
 * Admin categories — real data via the `/admin/categories` API (the page sits
 * behind the AdminAuthGate rendered by app/admin/layout.tsx). All the
 * interactivity lives in components/admin/CategoriesManager (jsx-a11y-linted).
 */
export default function AdminCategoriesPage() {
  return <CategoriesManager />;
}
