import { getServerUser } from "@/lib/auth/server";
import AdminAuthGate from "@/components/admin/AdminAuthGate";
import AdminLayoutShell from "./_layout-shell";

/**
 * Admin layout — server component and the admin auth boundary.
 *
 * The session cookie is opaque (role isn't encoded in it), so the real role
 * check happens here, server-side, via getServerUser() → GET /auth/me. When the
 * visitor is NOT an authenticated admin we render the `<AdminAuthGate>` (the
 * mandatory-TOTP login/enrolment flow) IN PLACE rather than redirecting. That
 * deliberately avoids a separate /admin/login route — a redirect target under
 * /admin would be re-wrapped by this very layout and loop. On success the gate
 * calls router.refresh(), this server layout re-runs, now resolves an admin
 * session, and renders the panel.
 *
 * Admin sessions are only ever minted after password + TOTP (see
 * backend/shop-api/src/routes/admin/auth.ts), so `role === "admin"` here already
 * implies AAL2 was satisfied.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getServerUser();
  if (!user || user.role !== "admin") {
    return <AdminAuthGate signedInAsNonAdmin={!!user} />;
  }

  return <AdminLayoutShell>{children}</AdminLayoutShell>;
}
