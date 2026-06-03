"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Mail, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { confirmEmailChange, validateEmailChangeToken } from "@/lib/auth/client";
import { useAuth } from "@/contexts/AuthContext";

/**
 * /account/email-change/verify?token=...
 *
 * The link delivered to the NEW email address points here. This page
 * mirrors the password-reset verify lifecycle:
 *
 *   1. On mount, fire `POST /auth/email-change/verify/check` to validate
 *      the token WITHOUT consuming it. Two outcomes:
 *        - live → show a one-click confirmation screen with the
 *          destination address ("you are confirming a change to X").
 *        - dead → terminal "invalid/expired" UI on first paint.
 *      This is the industry-standard UX (GitHub, Auth0, Stripe), and the
 *      check endpoint is read-only so it's safe to re-fire on dev's
 *      strict-mode double-invoke.
 *
 *   2. Confirming POSTs `/auth/email-change/verify`. The backend rotates
 *      `users.email`, marks the new address verified, drops EVERY session
 *      for the user (NIST + OWASP), and sends a notification to the OLD
 *      address.
 *
 *   3. On success: the local session cookie (if any) is now orphaned —
 *      we call useAuth().logout() to clear it cleanly, then redirect to
 *      /account/login?email-changed=success so the login page can render
 *      a green banner.
 *
 *   4. If the token goes dead BETWEEN the check-on-mount and the submit
 *      (someone else consumed it, or 1h elapsed while the user was
 *      reading), the consume returns invalid-email-change-token and we
 *      transition to the dead-link UI.
 *
 * Why not auto-confirm on mount?
 *   Email clients sometimes prefetch / scan the first link in a message
 *   (Microsoft Defender for Office 365, antivirus scanners). An auto-
 *   consume on mount would let a scanner burn the token before the user
 *   even sees the page. The explicit "Confirm" button means the scanner
 *   sees the page HTML but never POSTs the consume — only a real user
 *   click does that.
 */

const SUCCESS_TIMEOUT_MS = 30_000;

type Status =
  | { kind: "no-token" }
  | { kind: "checking" }
  | { kind: "live"; newEmail: string }
  | { kind: "dead" }
  | { kind: "submitting"; newEmail: string }
  | { kind: "success"; newEmail: string };

export default function EmailChangeVerifyPage() {
  const router = useRouter();
  const params = useSearchParams();
  const { logout, isLoggedIn } = useAuth();
  const token = params.get("token");

  const [error, setError] = useState<string | null>(null);

  // Lazy init: the no-token branch is the first render's terminal state.
  // For a present token we start in "checking" and transition to
  // live/dead from the mount effect.
  const [status, setStatus] = useState<Status>(() =>
    token ? { kind: "checking" } : { kind: "no-token" },
  );

  // React 19 strict-mode double-invokes effects in dev. The check
  // endpoint doesn't consume the token, so the second call is harmless
  // on the wire — but it would still race itself and possibly flash the
  // dead-link UI briefly on a slow network. The ref guards against that.
  const hasCheckedRef = useRef(false);

  useEffect(() => {
    if (!token) return;
    if (hasCheckedRef.current) return;
    hasCheckedRef.current = true;
    void (async () => {
      const res = await validateEmailChangeToken(token);
      if (res.ok) {
        setStatus({ kind: "live", newEmail: res.value.newEmail });
        return;
      }
      // On a network blip we don't have a destination address to render
      // — fall back to dead. Better to ask the user to request a new
      // link than to surface a half-broken confirmation screen.
      setStatus({ kind: "dead" });
    })();
  }, [token]);

  // After success, auto-redirect to login after a short delay so the
  // user has time to read the banner. They can also click immediately.
  useEffect(() => {
    if (status.kind !== "success") return;
    const t = setTimeout(() => {
      router.push("/account/login?email-changed=success");
    }, SUCCESS_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [status, router]);

  if (status.kind === "no-token" || status.kind === "dead") {
    const title =
      status.kind === "no-token" ? "Невалиден линк" : "Линкът е изтекъл";
    const body =
      status.kind === "no-token"
        ? "Линкът не съдържа токен. Моля проверете дали сте отворили правилния адрес от имейла за потвърждаване на нов имейл."
        : "Линкът за потвърждаване на нов имейл е невалиден или вече е използван. Линковете са валидни 1 час и могат да бъдат използвани само веднъж. Моля поискайте нова смяна от профила си.";
    return (
      <div className="container mx-auto max-w-lg px-4 py-16">
        <div className="rounded-lg border bg-card p-8 shadow-sm">
          <h1 className="mb-3 text-2xl font-semibold text-destructive">
            {title}
          </h1>
          <p className="mb-6 text-muted-foreground">{body}</p>
          <div className="flex gap-3">
            <ButtonLink href="/account/email-change">Нова заявка</ButtonLink>
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
            Изчакайте няколко секунди, докато проверим дали линкът все още
            е валиден.
          </p>
        </div>
      </div>
    );
  }

  if (status.kind === "success") {
    return (
      <div className="container mx-auto max-w-lg px-4 py-16">
        <div className="rounded-lg border bg-card p-8 shadow-sm">
          <h1 className="mb-3 text-2xl font-semibold text-green-700">
            Имейлът Ви е променен ✓
          </h1>
          <p className="mb-2 text-muted-foreground">
            Новият Ви имейл адрес е:
          </p>
          <p className="mb-6 font-medium">{status.newEmail}</p>
          <p className="mb-6 text-sm text-muted-foreground">
            От съображения за сигурност всички активни сесии бяха
            прекратени. Моля влезте отново с новия си имейл.
          </p>
          <div className="flex gap-3">
            <ButtonLink href="/account/login?email-changed=success">
              Към вход
            </ButtonLink>
          </div>
        </div>
      </div>
    );
  }

  // status.kind === "live" or "submitting" — show the confirm screen.
  const newEmail = status.newEmail;
  const submitting = status.kind === "submitting";

  async function handleConfirm() {
    if (!token) return;
    setError(null);
    setStatus({ kind: "submitting", newEmail });
    const res = await confirmEmailChange(token);
    if (!res.ok) {
      switch (res.error.kind) {
        case "invalid_email_change_token":
          // Race: token went dead between check and submit. Same dead-
          // link UI as the on-mount path.
          setStatus({ kind: "dead" });
          return;
        case "network":
          setError(
            "Не може да се свърже със сървъра. Проверете интернет връзката и опитайте отново.",
          );
          setStatus({ kind: "live", newEmail });
          return;
        default:
          setError("Възникна неочаквана грешка. Опитайте отново.");
          setStatus({ kind: "live", newEmail });
          return;
      }
    }
    // Success: the backend dropped every session for this user — if we
    // were logged in on THIS device, our cookie is now orphaned. Call
    // logout() to clean it up locally so the subsequent push to /login
    // isn't bounced by the proxy. /auth/logout is idempotent and safe
    // even when the device wasn't logged in.
    if (isLoggedIn) {
      await logout();
    }
    setStatus({ kind: "success", newEmail });
  }

  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <ButtonLink
          variant="ghost"
          size="sm"
          href="/account/login"
          className="gap-1.5 mb-6 -ml-2"
        >
          <ArrowLeft className="w-4 h-4" /> Към вход
        </ButtonLink>

        <div className="mb-6">
          <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
            <Mail className="w-6 h-6 text-primary-strong" />
          </div>
          <h1 className="text-2xl font-bold">Потвърди новия имейл</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Ще зададем новия имейл адрес на акаунта Ви:
          </p>
        </div>

        <div className="mb-6 rounded-lg border bg-card p-4">
          <p className="font-medium break-all">{newEmail}</p>
        </div>

        <p className="mb-6 text-sm text-muted-foreground">
          След потвърждаването всички активни сесии в акаунта Ви ще бъдат
          прекратени и ще трябва да влезете отново с новия имейл.
        </p>

        {error && (
          <p
            role="alert"
            aria-live="polite"
            className="mb-4 text-sm text-destructive bg-destructive/5 border border-destructive/20 rounded-md p-2"
          >
            {error}
          </p>
        )}

        <Button
          type="button"
          className="w-full"
          disabled={submitting}
          onClick={() => {
            void handleConfirm();
          }}
        >
          {submitting ? "Потвърждаване..." : "Потвърди смяната"}
        </Button>

        <p className="text-xs text-muted-foreground mt-4 text-center">
          Линкът е валиден 1 час и може да бъде използван само веднъж.
        </p>
      </div>
    </div>
  );
}
