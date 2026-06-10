import OrderDetailPanel from "@/components/admin/OrderDetailPanel";

/**
 * Admin order detail — real data via `/admin/orders/:orderNumber` (the page
 * sits behind the AdminAuthGate rendered by app/admin/layout.tsx). The param
 * is the PUBLIC order number (e.g. 2026-06-00042), matching the customer
 * routes and the spec's admin list — not the internal UUID.
 */
export default async function AdminOrderDetailPage({
  params,
}: {
  params: Promise<{ orderNumber: string }>;
}) {
  const { orderNumber } = await params;
  return <OrderDetailPanel orderNumber={decodeURIComponent(orderNumber)} />;
}
