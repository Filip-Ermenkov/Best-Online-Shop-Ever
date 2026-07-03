import CustomersManager from "@/components/admin/CustomersManager";

/**
 * Admin account management — real data via the `/admin/customers` API (the page
 * sits behind the AdminAuthGate rendered by app/admin/layout.tsx). All the
 * interactivity lives in components/admin/CustomersManager (jsx-a11y-linted):
 * the searchable/paginated customer list, per-account discount management (spec
 * §11), the order history, and account deletion (blocked while orders are
 * active). Un-mocks the previous frontend/src/lib/mock-data/customers.ts screen.
 */
export default function AdminCustomersPage() {
  return <CustomersManager />;
}
