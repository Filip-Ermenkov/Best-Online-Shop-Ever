import { redirect } from "next/navigation";
import { getServerUser } from "@/lib/auth/server";
import AdminLayoutShell from "./_layout-shell";

/**
 * Admin layout — server component. Performs the role check that the proxy
 * cannot (the session cookie is opaque, role isn't encoded in it). The
 * proxy already redirected anonymous traffic to /account/login, so by the
 * time we reach here we have *some* user. We then enforce role === "admin".
 *
 * Customer who lands on /admin (e.g. via a bookmarked URL) is bounced back
 * to / rather than seeing a hard 403 — fewer support tickets, same
 * security posture (they don't see admin content).
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getServerUser();
  if (!user) redirect("/account/login?next=/admin");
  if (user.role !== "admin") redirect("/");

  return <AdminLayoutShell>{children}</AdminLayoutShell>;
}
