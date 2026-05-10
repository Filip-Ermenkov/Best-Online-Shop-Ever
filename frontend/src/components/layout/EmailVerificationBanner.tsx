"use client";

import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { resendVerification } from "@/lib/auth/client";

/**
 * Sticky banner shown to authenticated users whose `emailVerifiedAt` is null.
 *
 * Behaviour:
 *   - Hidden when not authenticated (no banner in pre-login flows).
 *   - Hidden when emailVerifiedAt is set (the desired terminal state).
 *   - "Изпрати отново" calls POST /auth/resend-verification. Backend rate
 *     limits at 3/hour, 5/day per user; we surface the 429 message.
 *
 * Why a banner and not a modal?
 *   Verification is non-blocking — the user can browse and build a cart
 *   while unverified. Only checkout requires verification (the API enforces
 *   this with a 403 at POST /orders). A banner stays out of the way until
 *   the user is ready to act.
 *
 * Why this lives in (shop)/layout and not the root layout?
 *   The admin dashboard is its own surface; admins don't have a customer
 *   email-verification flow. Keeping the banner in the customer layout
 *   makes the boundary explicit.
 */
export default function EmailVerificationBanner() {
  const { user, isLoggedIn, refresh } = useAuth();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<
    | { kind: "ok"; message: string }
    | { kind: "error"; message: string }
    | null
  >(null);

  if (!isLoggedIn || !user) return null;
  if (user.emailVerifiedAt) return null;

  async function handleResend() {
    setPending(true);
    setFeedback(null);
    const res = await resendVerification();
    setPending(false);

    if (res.ok) {
      setFeedback({
        kind: "ok",
        message: "Изпратихме нов линк за потвърждение. Проверете пощата си.",
      });
      // Refresh /auth/me — if the user verified in another tab between the
      // banner showing and clicking, the next render hides this banner.
      await refresh();
      return;
    }

    if (res.error.kind === "resend_rate_limited") {
      setFeedback({
        kind: "error",
        message:
          res.error.detail ??
          "Твърде много заявки. Моля опитайте по-късно.",
      });
      return;
    }
    setFeedback({
      kind: "error",
      message:
        "Възникна грешка при изпращането. Моля опитайте отново след малко.",
    });
  }

  return (
    <div
      role="status"
      className="border-b border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
    >
      <div className="container mx-auto flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <span>
          Имейл адресът Ви все още не е потвърден. Без потвърждение няма да
          можете да правите поръчки.
        </span>
        <div className="flex items-center gap-3">
          {feedback && (
            <span
              className={
                feedback.kind === "ok"
                  ? "text-green-700"
                  : "text-destructive"
              }
            >
              {feedback.message}
            </span>
          )}
          <button
            type="button"
            onClick={handleResend}
            disabled={pending}
            className="rounded-md border border-amber-400 bg-white px-3 py-1.5 text-sm font-medium text-amber-900 transition hover:bg-amber-100 disabled:opacity-50"
          >
            {pending ? "Изпращане…" : "Изпрати отново"}
          </button>
        </div>
      </div>
    </div>
  );
}
