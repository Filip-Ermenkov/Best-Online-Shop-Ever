import OrdersExplorer from "@/components/admin/OrdersExplorer";

/**
 * Admin orders list — real data via the `/admin/orders` API (the page sits
 * behind the AdminAuthGate rendered by app/admin/layout.tsx). All the
 * interactivity lives in components/admin/OrdersExplorer (jsx-a11y-linted).
 */
export default function AdminOrdersPage() {
  return <OrdersExplorer />;
}
