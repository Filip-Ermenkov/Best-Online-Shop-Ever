import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { clearSessionCookie, sessionCookieName } from "../lib/cookies.js";
import { ApiError } from "../lib/errors.js";
import { validateSession, type SessionAndUser } from "../lib/sessions.js";

/**
 * Two-tier middleware design:
 *
 *   currentUser   — best-effort. Reads the cookie, validates the session,
 *                   populates c.var.user / c.var.session if the session is
 *                   valid. NEVER 401s. Anonymous traffic flows through
 *                   unaffected. This is the right shape for routes that
 *                   change behaviour based on identity (cart preview,
 *                   personalised category sort) without requiring auth.
 *
 *   requireAuth   — gate. Same logic, but throws 401 if no valid session.
 *                   Use ON TOP OF currentUser for routes that MUST have a
 *                   user (account page, place order, admin everything).
 *
 * The two are split because most reads are cheap and shouldn't 401-bounce
 * users off the homepage just because their cookie expired. The few writes
 * that need auth opt in explicitly.
 *
 * Hono's `c.set("user", user)` keeps strong typing through the AppVariables
 * declaration in app.ts.
 */

export type AuthVariables = {
  /** Present iff the request has a valid session cookie. */
  user?: SessionAndUser["user"];
  session?: SessionAndUser["session"];
};

/**
 * Best-effort: try to resolve the session, swallow failures.
 * NEVER throws on missing/invalid cookie — that would force every route to
 * be auth-aware.
 */
export const currentUser: MiddlewareHandler<{ Variables: AuthVariables }> =
  async (c, next) => {
    const token = getCookie(c, sessionCookieName());
    if (!token) {
      return next();
    }

    try {
      const result = await validateSession(token);
      if (result) {
        c.set("user", result.user);
        c.set("session", result.session);
      } else {
        // The cookie was present, but the session is gone — expired, the
        // user was deleted, or the session row was dropped (the canonical
        // case: someone hit /auth/reset-password from another device,
        // which calls `deleteAllSessionsForUser`).
        //
        // Set-Cookie with Max-Age=0 wipes the now-orphaned cookie from the
        // caller's browser. Without this, the cookie keeps coming back on
        // every request and the thin proxy keeps treating cookie-presence
        // as "logged in" — bouncing /account/login to /account/profile,
        // which 401s, which redirects back to /login, in a UX loop the
        // user can't escape from without manually clearing cookies.
        //
        // We do this in `currentUser` (not `requireAuth`) so the cleanup
        // happens on EVERY route that mounts this middleware — including
        // anonymous-allowed reads like /products and /categories. One
        // navigation anywhere on the site is enough to break Browser B
        // out of the loop.
        clearSessionCookie(c);
      }
    } catch {
      // DB hiccup → treat as anonymous. The next request will retry.
      // Don't leak the error into the request lifecycle, and don't
      // clear the cookie either — it may be perfectly valid; we just
      // couldn't reach the DB.
    }

    return next();
  };

/**
 * Gate. Pair with currentUser:
 *
 *   subRouter.use("*", currentUser, requireAuth);
 *
 * or per-route. Throws ApiError(401) — which the global error handler maps
 * to an RFC 9457 problem.
 */
export const requireAuth: MiddlewareHandler<{ Variables: AuthVariables }> =
  async (c, next) => {
    if (!c.get("user")) {
      throw new ApiError({
        type: "about:blank",
        title: "Unauthorized",
        status: 401,
        detail: "Authentication is required.",
      });
    }
    return next();
  };
