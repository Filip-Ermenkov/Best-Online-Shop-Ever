import type { MiddlewareHandler } from "hono";
import { ApiError } from "../lib/errors.js";
import type { AuthVariables } from "./auth.js";

/**
 * Admin gate. Pair with currentUser (which resolves the session cookie):
 *
 *   adminAuthRoutes.use("/me", currentUser, requireAdmin);
 *
 * Requires a valid session whose user has role="admin". A non-admin (or
 * anonymous) caller gets a flat 404 — NOT a 401/403 — so the very existence of
 * the admin surface is not confirmable to a customer or an anonymous probe
 * (the admin panel lives on its own subdomain in the target topology; this
 * keeps the API honest to that separation even while co-hosted).
 *
 * Defence-in-depth note: an admin session is ONLY ever minted by the
 * /admin/auth MFA flow, i.e. after both password AND TOTP have been proven, so
 * "role=admin session exists" already implies AAL2 was satisfied. We therefore
 * gate on role here and keep the check cheap (no extra DB read).
 */
export const requireAdmin: MiddlewareHandler<{ Variables: AuthVariables }> =
  async (c, next) => {
    const user = c.get("user");
    if (!user || user.role !== "admin") {
      // Uniform 404 — same body an unknown route would return (see app.notFound).
      throw new ApiError({
        type: "about:blank",
        title: "Not Found",
        status: 404,
        detail: `No route for ${c.req.method} ${c.req.path}`,
      });
    }
    return next();
  };
