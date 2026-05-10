"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { verifyEmail } from "@/lib/auth/client";
import { useAuth } from "@/contexts/AuthContext";
import { ButtonLink } from "@/components/ui/button-link";

/**
 * /account/verify-email?token=...
 *
 * The verification email links here. We POST the token to /auth/verify-email
 * once on mount and render one of three states:
 *
 *   - pending   → spinner-ish "Verifying..." copy. Brief; one round-trip.
 *   - success   → confirmation copy + CTA back to /account or /checkout.
 *   - failure   → generic "invalid or expired" copy + CTA to /account so
 *                 the user can request a fresh link from the banner.
 *
 * Why the duplicate-call guard (`hasVerifiedRef`)?
 *
 *   React 19's strict-mode dev environment double-invokes effects to surface
 *   non-idempotent code. POSTing the token twice would:
 *     (a) burn the token (the second POST sees `consumed_at` set and 400s),
 *     (b) flash an error UI on the dev path even though the first call
 *         succeeded.
 *   The ref guards against that without disabling strict mode.
 *
 * Why initial state is computed lazily from the token?
 *   So the "no token in URL" branch never has to setState inside the effect
 *   body — it's the first render that already shows the failure copy. That
 *   keeps the effect doing only one job (the verify round-trip).
 *
 * Why the success branch refreshes AuthContext?
 *
 *   If the user is already logged in (which is the common case — register
 *   redirects to login, login lands on /account, banner sees the unverified
 *   state and surfaces the link) the in-memory `user.emailVerifiedAt` is
 *   stale until /auth/me re-reads it. Refreshing here makes the banner
 *   disappear without waiting for the next mount.
 */

type Status =
  | { kind: "pending" }
  | { kind: "success" }
  | { kind: "failure"; detail?: string };

export default function VerifyEmailPage() {
  const params = useSearchParams();
  const token = params.get("token");
  const { refresh, isLoggedIn } = useAuth();
  const hasVerifiedRef = useRef(false);

  // Lazy init: a missing token is the first render's terminal state. No
  // setState in the effect for that branch.
  const [status, setStatus] = useState<Status>(() =>
    token
      ? { kind: "pending" }
      : {
          kind: "failure",
          detail:
            "Линкът не съдържа токен. Моля проверете дали сте отворили правилния адрес.",
        },
  );

  useEffect(() => {
    if (!token) return;
    if (hasVerifiedRef.current) return;
    hasVerifiedRef.current = true;
    // setState happens inside an async callback — that's fine: the rule
    // targets synchronous setState in the effect body, not async fetch
    // results. This is the canonical "fire request, store result" pattern.
    void (async () => {
      const res = await verifyEmail(token);
      if (res.ok) {
        if (isLoggedIn) {
          await refresh();
        }
        setStatus({ kind: "success" });
      } else {
        const detail =
          res.error.kind === "network"
            ? "Връзката с сървъра пропадна. Моля опитайте отново."
            : "Линкът е невалиден или е изтекъл.";
        setStatus({ kind: "failure", detail });
      }
    })();
  }, [token, refresh, isLoggedIn]);

  return (
    <div className="container mx-auto max-w-lg px-4 py-16">
      <div className="rounded-lg border bg-card p-8 shadow-sm">
        {status.kind === "pending" && (
          <>
            <h1 className="mb-3 text-2xl font-semibold">Потвърждаване на имейл…</h1>
            <p className="text-muted-foreground">
              Изчакайте няколко секунди, докато проверим линка.
            </p>
          </>
        )}

        {status.kind === "success" && (
          <>
            <h1 className="mb-3 text-2xl font-semibold text-green-700">
              Имейлът Ви е потвърден ✓
            </h1>
            <p className="mb-6 text-muted-foreground">
              Благодарим Ви! Вече можете да правите поръчки.
            </p>
            <div className="flex gap-3">
              <ButtonLink href="/account">Към профила</ButtonLink>
              <ButtonLink href="/" variant="outline">
                Към магазина
              </ButtonLink>
            </div>
          </>
        )}

        {status.kind === "failure" && (
          <>
            <h1 className="mb-3 text-2xl font-semibold text-destructive">
              Невалиден линк
            </h1>
            <p className="mb-6 text-muted-foreground">
              {status.detail ??
                "Линкът е невалиден или е изтекъл. Поискайте нов от профила си."}
            </p>
            <div className="flex gap-3">
              <ButtonLink href="/account">Към профила</ButtonLink>
              <ButtonLink href="/account/login" variant="outline">
                Вход
              </ButtonLink>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
