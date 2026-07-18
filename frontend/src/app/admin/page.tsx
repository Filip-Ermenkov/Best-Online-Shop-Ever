import DashboardManager from "@/components/admin/DashboardManager";

/**
 * /admin — the real dashboard (docs/README.md §"Табло"). A thin server-component
 * wrapper around the client DashboardManager, which pulls the whole operational
 * overview from the `/admin/dashboard` API through the typed client in
 * lib/admin/dashboard/. Replaces the former mock tiles that read fabricated
 * numbers off frontend/src/lib/mock-data/* (roadmap item 50).
 */
export default function AdminDashboardPage() {
  return <DashboardManager />;
}
