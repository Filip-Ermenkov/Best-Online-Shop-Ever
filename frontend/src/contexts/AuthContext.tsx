"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  fetchMe,
  login as apiLogin,
  logout as apiLogout,
  register as apiRegister,
} from "@/lib/auth/client";
import type {
  AuthResult,
  AuthUser,
  LoginInput,
  RegisterInput,
} from "@/lib/auth/types";

/**
 * Client-side auth state. Hydrates from GET /auth/me on mount, then
 * stays in sync via the explicit login/logout/register actions.
 *
 * Why fetch /auth/me on mount instead of relying on a Server Component
 * to inject initial state?
 *
 *   - The session cookie is HttpOnly, so client JS can't read it directly.
 *     The only way for the browser to learn "am I logged in?" is to ask
 *     the API.
 *   - The fetch is cheap (single indexed lookup on sessions.id_hash) and
 *     happens once per page load. After that, identity changes only when
 *     the user explicitly logs in/out.
 *   - SSR-side identity is available separately via getServerUser() in
 *     lib/auth/server.ts — Server Components prefer that path because it
 *     avoids a client-side flicker. The two paths converge: same /auth/me
 *     endpoint, same AuthUser shape.
 *
 * `status === "loading"` covers the brief window between mount and the
 * first /auth/me response. UI consumers should treat it as "I don't know
 * yet" — typically a skeleton or no flash of "Sign in" briefly.
 */

export type AuthStatus = "loading" | "authenticated" | "anonymous";

interface AuthContextValue {
  user: AuthUser | null;
  status: AuthStatus;
  /** True iff status === "authenticated". Convenience for current callers. */
  isLoggedIn: boolean;
  login(input: LoginInput): Promise<AuthResult<AuthUser>>;
  register(input: RegisterInput): Promise<AuthResult<{ ok: true }>>;
  logout(): Promise<void>;
  /** Refetch /auth/me — useful after a profile edit or password change. */
  refresh(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface AuthProviderProps {
  children: React.ReactNode;
  /**
   * Initial user from a Server Component (via getServerUser()). When
   * provided, the provider skips the loading state on first paint —
   * the SSR markup already shows the right header.
   *
   * Pass `undefined` (the default) to do client-side bootstrap.
   * Pass `null` explicitly when SSR confirmed the visitor is anonymous.
   */
  initialUser?: AuthUser | null;
}

export function AuthProvider({ children, initialUser }: AuthProviderProps) {
  const [user, setUser] = useState<AuthUser | null>(initialUser ?? null);
  const [status, setStatus] = useState<AuthStatus>(
    initialUser === undefined
      ? "loading"
      : initialUser === null
        ? "anonymous"
        : "authenticated",
  );

  const refresh = useCallback(async () => {
    const res = await fetchMe();
    if (res.ok) {
      setUser(res.value);
      setStatus("authenticated");
    } else {
      setUser(null);
      setStatus("anonymous");
    }
  }, []);

  // Bootstrap on mount only when we don't already have an SSR-provided user.
  //
  // The lint suppression below is deliberate. `react-hooks/set-state-in-effect`
  // (new in React 19) flags the chain because `refresh()` ultimately calls
  // `setUser`/`setStatus`. That's the canonical "subscribe to / read from an
  // external system on mount" pattern useEffect was designed for — the
  // external system is the session cookie + GET /auth/me. The proper "fix"
  // is a data-fetching layer (TanStack Query, SWR, Suspense + use()), which
  // is a separate slice. Until then this is intentionally an effect, runs
  // exactly once per mount when no SSR user is present, and does NOT cascade
  // (refresh resolves to a stable user/anonymous state).
  useEffect(() => {
    if (initialUser !== undefined) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see block comment above
    void refresh();
  }, [initialUser, refresh]);

  const login = useCallback(
    async (input: LoginInput): Promise<AuthResult<AuthUser>> => {
      const res = await apiLogin(input);
      if (res.ok) {
        setUser(res.value);
        setStatus("authenticated");
      }
      return res;
    },
    [],
  );

  const register = useCallback(
    async (input: RegisterInput): Promise<AuthResult<{ ok: true }>> => {
      // Register does NOT log the user in. The spec's flow is:
      //   register → check inbox → click verification link → log in.
      // Until SES + verification ship, the UI shows a "check your email"
      // message and routes the user to /account/login afterwards.
      return apiRegister(input);
    },
    [],
  );

  const logout = useCallback(async () => {
    // Optimistic clear so the header updates instantly even if the network
    // is slow. The server-side delete is idempotent, so a failure here just
    // means the cookie sticks around in the browser for its TTL — the
    // cookie clear is the source of truth for "am I logged out client-side".
    setUser(null);
    setStatus("anonymous");
    await apiLogout();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      status,
      isLoggedIn: status === "authenticated",
      login,
      register,
      logout,
      refresh,
    }),
    [user, status, login, register, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

// Re-export the user type so existing consumers (Header, account pages)
// don't need to change their imports. Old AuthUser shape from
// lib/types.ts had firstName/lastName/discountPercent — those weren't
// real backend fields. The new shape uses fullName + role + accountType.
// Header is updated separately to display fullName (or fall back to email).
export type { AuthUser };

// Removed: MOCK_CUSTOMER, MOCK_ADMIN. Anything still referencing those
// imports needs to migrate to the real API.
