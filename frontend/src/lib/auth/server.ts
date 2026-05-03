import "server-only";
import { cookies } from "next/headers";
import type { AuthUser } from "./types";

/**
 * SSR identity bootstrap.
 *
 * Reads the incoming request's session cookie via next/headers and forwards
 * it on a server-side fetch to GET /auth/me. Returns the user, or null if
 * the cookie is missing/invalid.
 *
 * Used from layouts and Server Components that want to render different
 * markup based on whether the visitor is logged in (e.g. the header,
 * personalised category sort). NEVER call from client code — server-only
 * is enforced at the package level.
 *
 * Important architectural notes:
 *
 *   - Server Components can READ cookies but cannot SET them. That's why
 *     login goes through a client-side fetch — the API's Set-Cookie has to
 *     hit the browser directly. Never try to "log in from a Server Action"
 *     unless you also relay the Set-Cookie via Next's cookie store, which
 *     is more complex than it looks (the trapped-cookie problem).
 *
 *   - We deliberately don't cache this fetch. The whole point of /auth/me
 *     is "right now". Stale-while-revalidate would mean a user who just
 *     logged out still sees themselves logged in for up to 5 minutes.
 *
 *   - Cookie name varies by env: `__Host-shop_session` in production, plain
 *     `shop_session` in dev. `cookies()` is async in Next.js 15+.
 */
export async function getServerUser(): Promise<AuthUser | null> {
  const cookieStore = await cookies();
  // Try both names — the production `__Host-` prefix is required when the
  // API runs behind https, but local dev runs over http://localhost which
  // browsers reject Secure cookies on, so dev uses the unprefixed name.
  const token =
    cookieStore.get("__Host-shop_session")?.value ??
    cookieStore.get("shop_session")?.value;

  if (!token) return null;

  const baseUrl =
    process.env.NEXT_PUBLIC_SHOP_API_URL?.replace(/\/+$/, "") ??
    "http://localhost:3001";

  // Build the cookie header explicitly. We can't use credentials: "include"
  // here because this fetch is server-to-server (no browser involved); the
  // cookie has to ride in a Cookie request header that we set ourselves.
  const cookieHeader =
    cookieStore.get("__Host-shop_session")
      ? `__Host-shop_session=${token}`
      : `shop_session=${token}`;

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/auth/me`, {
      headers: { Cookie: cookieHeader, Accept: "application/json" },
      cache: "no-store",
    });
  } catch {
    // API unreachable — pretend the user is anonymous rather than crashing
    // the page. The error will surface in CloudWatch logs from the API side
    // if the API is down; the frontend stays best-effort.
    return null;
  }

  if (!res.ok) return null;
  const body = (await res.json()) as { user: AuthUser };
  return body.user;
}
