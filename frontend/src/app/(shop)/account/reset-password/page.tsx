"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { KeyRound, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { resetPassword, validateResetToken } from "@/lib/auth/client";
import { useAuth } from "@/contexts/AuthContext";

/**
 * /account/reset-password?token=...
 *
 * Two password inputs (new + confirm) plus a hidden token from the URL.
 * On success: redirects to /account/login?reset=success so the login page
 * can render a one-time success banner.
 *
 * Lifecycle:
 *
 *   1. On mount, fire `POST /auth/reset-password/check` to validate the
 *      token WITHOUT consuming it. Until the response comes back the page
 *      shows a brief "Проверка на линка..." state. This is the industry-
 *      standard UX (GitHub, Google, Auth0, Stripe) — typing a new password
 *      only to learn the link is dead is wasted effort. The check endpoint
 *      is read-only; double-firing in strict-mode dev is harmless (and a
 *      useRef guard avoids the duplicate request anyway).
 *
 *   2. If the token is live, the form is shown. Submit calls
 *      `POST /auth/reset-password` which rotates the password, drops every
 *      session for the user, and sends the post-reset notification email.
 *
 *   3. If the token is dead (consumed/expired/unknown) — either on mount
 *      or after submit (race: someone else could have used the token
 *      between the check and the submit) — the page locks into the dead-
 *      link state with a "Поискай нов линк" CTA.
 *
 * Why not log the user in automatically on success?
 *   The reset endpoint drops EVERY session for the user (NIST + OWASP
 *   defence-in-depth). Auto-login would benefit an attacker who clicked
 *   the link in a phished mailbox just as much as the user. The user
 *   re-authenticates with their new password — that's the contract.
 *
 * Confirm-password is enforced on the client only. The API has no notion
 * of "confirm" — that's purely a typo guard.
 */

const PASSWORD_HELP =
  "Минимум 12 символа. Дълга фраза с няколко думи е по-сигурна от къса парола със знаци.";

type TokenStatus =
  | { kind: "no-token" }
  | { kind: "checking" }
  | { kind: "live" }
  | { kind: "dead" };

export default function ResetPasswordPage() {
  const router = useRouter();
  const params = useSearchParams();
  const { logout, isLoggedIn } = useAuth();
  const token = params.get("token");

  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Lazy init: the no-token branch is the first render's terminal state, no
  // effect needed for it. For a present token we start in "checking" and
  // transition to live/dead from the mount effect.
  const [status, setStatus] = useState<TokenStatus>(() =>
    token ? { kind: "checking" } : { kind: "no-token" },
  );

  // React 19 strict-mode double-invokes effects in dev. The check endpoint
  // doesn't consume the token, so the second call is harmless on the wire
  // — but it would still race itself and possibly flash the dead-link UI
  // briefly on a slow network. The ref guards against that.
  const hasCheckedRef = useRef(false);

  useEffect(() => {
    if (!token) return;
    if (hasCheckedRef.current) return;
    hasCheckedRef.current = true;
    void (async () => {
      const res = await validateResetToken(token);
      if (res.ok) {
        setStatus({ kind: "live" });
        return;
      }
      // On a network blip, keep the form usable rather than locking the
      // user out. The submit handler will surface a clear error if the
      // backend is genuinely down, and the token may still be live.
      if (res.error.kind === "network") {
        setStatus({ kind: "live" });
        return;
      }
      setStatus({ kind: "dead" });
    })();
  }, [token]);

  if (status.kind === "no-token" || status.kind === "dead") {
    const title = status.kind === "no-token" ? "Невалиден линк" : "Линкът е изтекъл";
    const body =
      status.kind === "no-token"
        ? "Линкът не съдържа токен. Моля проверете дали сте отворили правилния адрес от имейла за нулиране на парола."
        : "Линкът за нулиране на парола е невалиден или вече е използван. Линковете са валидни 1 час и могат да бъдат използвани само веднъж. Моля поискайте нов от страницата за забравена парола.";
    return (
      <div className="container mx-auto max-w-lg px-4 py-16">
        <div className="rounded-lg border bg-card p-8 shadow-sm">
          <h1 className="mb-3 text-2xl font-semibold text-destructive">{title}</h1>
          <p className="mb-6 text-muted-foreground">{body}</p>
          <div className="flex gap-3">
            <ButtonLink href="/account/forgot-password">
              Поискай нов линк
            </ButtonLink>
            <ButtonLink href="/account/login" variant="outline">
              Вход
            </ButtonLink>
          </div>
        </div>
      </div>
    );
  }

  if (status.kind === "checking") {
    return (
      <div className="container mx-auto max-w-lg px-4 py-16">
        <div className="rounded-lg border bg-card p-8 shadow-sm">
          <h1 className="mb-3 text-2xl font-semibold">Проверка на линка…</h1>
          <p className="text-muted-foreground">
            Изчакайте няколко секунди, докато проверим дали линкът все още е валиден.
          </p>
        </div>
      </div>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (newPassword !== confirm) {
      setError("Паролите не съвпадат.");
      return;
    }
    if (newPassword.length < 12) {
      setError("Паролата трябва да е поне 12 символа.");
      return;
    }
    // No client-side composition checks — the server enforces only length
    // and breached-password screening (NIST SP 800-63B Rev. 4). A breached
    // password is rejected by the API with a field-level "data breach"
    // message which we surface as-is in the validation switch below.

    setPending(true);
    try {
      const res = await resetPassword(token!, newPassword);
      if (!res.ok) {
        switch (res.error.kind) {
          case "invalid_reset_token":
            // Race: another tab consumed the token between our mount-check
            // and this submit, OR the 1h window elapsed while the user was
            // typing. Same dead-link UI as the on-mount path.
            setStatus({ kind: "dead" });
            return;
          case "breached_password":
            setError(
              "Тази парола е била включена в известен пробив в данни и не може да бъде използвана. Моля, изберете различна, по-добре дълга фраза.",
            );
            return;
          case "validation":
            setError(res.error.fields[0]?.message ?? PASSWORD_HELP);
            return;
          case "network":
            setError(
              "Не може да се свърже със сървъра. Проверете интернет връзката.",
            );
            return;
          default:
            setError("Възникна неочаквана грешка. Опитайте отново.");
            return;
        }
      }
      // The reset endpoint dropped every session for the user server-side,
      // including this device's if it happened to be logged in. The cookie
      // still sits in the browser though, and the proxy treats cookie-
      // presence as "logged in" — without clearing it locally, the
      // subsequent push to /account/login would be bounced to
      // /account/profile by the proxy, then 401 on /auth/me, creating a
      // confusing loop. Calling logout() issues a 204 from /auth/logout
      // which Set-Cookie-clears the cookie cleanly. /auth/logout is
      // idempotent, so this is also safe when the device wasn't logged in.
      if (isLoggedIn) {
        await logout();
      }
      router.push("/account/login?reset=success");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <ButtonLink
          variant="ghost"
          size="sm"
          href="/account/login"
          className="gap-1.5 mb-6 -ml-2"
        >
          <ArrowLeft className="w-4 h-4" /> Обратно към вход
        </ButtonLink>

        <div className="mb-6">
          <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
            <KeyRound className="w-6 h-6 text-primary-strong" />
          </div>
          <h1 className="text-2xl font-bold">Нова парола</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Изберете нова парола. След запазването всички активни сесии в
            акаунта Ви ще бъдат прекратени и ще трябва да влезете отново.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div>
            <Label htmlFor="newPassword">Нова парола</Label>
            <Input
              id="newPassword"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              required
              className="mt-1"
              disabled={pending}
            />
            <p className="mt-1 text-xs text-muted-foreground">{PASSWORD_HELP}</p>
          </div>
          <div>
            <Label htmlFor="confirm">Потвърди нова парола</Label>
            <Input
              id="confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
              className="mt-1"
              disabled={pending}
            />
          </div>

          {error && (
            <p
              role="alert"
              aria-live="polite"
              className="text-sm text-destructive bg-destructive/5 border border-destructive/20 rounded-md p-2"
            >
              {error}
            </p>
          )}

          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Запазване..." : "Запази новата парола"}
          </Button>
        </form>

        <p className="text-center text-sm text-muted-foreground mt-6">
          Спомнихте си старата парола?{" "}
          <Link
            href="/account/login"
            className="text-primary-strong underline"
          >
            Влезте тук
          </Link>
        </p>
      </div>
    </div>
  );
}
