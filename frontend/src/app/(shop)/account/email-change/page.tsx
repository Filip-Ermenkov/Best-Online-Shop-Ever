"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/AuthContext";
import { requestEmailChange } from "@/lib/auth/client";

/**
 * /account/email-change
 *
 * Authenticated form for requesting an email-address change. The user
 * supplies their CURRENT password (re-auth proof) plus the proposed new
 * email. On submit:
 *
 *   - Backend silently 200s in ALL the enumeration-sensitive cases
 *     (rate-limit hit, new address already in use). The UI mirrors that
 *     by always showing the same "we sent you a link" success copy when
 *     the backend says ok.
 *   - 400 → render the field-level message (malformed email OR new ==
 *     current). The two cases land on the same UI branch — the only
 *     thing the user can do is fix the input.
 *   - 401 → "Текущата парола е грешна." Distinct branch because the user
 *     CAN do something about it.
 *
 * Why no "confirm new email" field?
 *   The change isn't final until the user clicks a link delivered to the
 *   new address — a typo simply means no email arrives and the user
 *   re-submits. Adding a confirm field would be pure friction.
 *
 * After success the user must:
 *   1. Open the verify email on the new address → click the link.
 *   2. The verify page rotates the email and drops their sessions.
 *   3. They re-log-in with the new address.
 * The OLD address gets two emails: an alert at request time (so an
 * unauthorised change is immediately visible there) and a notification
 * after the verify is consumed.
 */

export default function EmailChangePage() {
  const router = useRouter();
  const { user, status, refresh } = useAuth();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  // Client-side gate. Real protection is in proxy.ts (cookie-presence
  // check). The status === "loading" path covers the brief race where the
  // page mounts before AuthContext finished its /auth/me fetch.
  useEffect(() => {
    if (status === "anonymous") {
      router.replace("/account/login?next=/account/email-change");
    }
  }, [status, router]);

  // Refresh auth state on mount so the current email reflected in the
  // form preamble is up-to-date even if the user just changed it from a
  // different tab/device.
  useEffect(() => {
    if (status === "authenticated") void refresh();
    // refresh is stable; we only want this on the auth-state transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  if (status !== "authenticated" || !user) {
    return (
      <div className="max-w-md mx-auto px-4 py-12 text-center text-sm text-muted-foreground">
        Зареждане...
      </div>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const trimmedEmail = newEmail.trim();
    if (!trimmedEmail) {
      setError("Моля въведете нов имейл адрес.");
      return;
    }
    if (!currentPassword) {
      setError("Моля въведете текущата си парола.");
      return;
    }
    // Client-side identity check: catches a typo'd "change to my own
    // address" before a round-trip. The backend has the canonical rule.
    if (
      user &&
      trimmedEmail.toLowerCase() === user.email.toLowerCase()
    ) {
      setError("Новият имейл трябва да е различен от текущия.");
      return;
    }

    setPending(true);
    try {
      const res = await requestEmailChange({
        currentPassword,
        newEmail: trimmedEmail,
      });
      if (!res.ok) {
        switch (res.error.kind) {
          case "invalid_credentials":
            setError("Текущата парола е грешна.");
            return;
          case "validation":
            setError(
              res.error.fields[0]?.message ??
                "Моля проверете въведените данни.",
            );
            return;
          case "network":
            setError(
              "Не може да се свърже със сървъра. Проверете интернет връзката и опитайте отново.",
            );
            return;
          default:
            // Same defensive posture as the forgot-password page: any
            // unknown failure still lands on the success copy. The worst
            // case is the user notices no email arriving and re-submits.
            setSent(true);
            return;
        }
      }
      setSent(true);
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
          href="/account/profile"
          className="gap-1.5 mb-6 -ml-2"
        >
          <ArrowLeft className="w-4 h-4" /> Обратно към профила
        </ButtonLink>

        <div className="mb-6">
          <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
            <Mail className="w-6 h-6 text-primary-strong" />
          </div>
          <h1 className="text-2xl font-bold">Смяна на имейл адрес</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Текущ адрес:{" "}
            <span className="font-medium text-foreground">{user.email}</span>
          </p>
        </div>

        {sent ? (
          <div
            className="rounded-lg border border-green-200 bg-green-50 p-5 space-y-3"
            role="status"
            aria-live="polite"
          >
            <p className="font-semibold text-green-700">
              Проверете новата си поща
            </p>
            <p className="text-sm text-green-700">
              Изпратихме линк за потвърждаване на{" "}
              <span className="font-medium">{newEmail.trim()}</span>. Линкът
              е валиден 1 час и може да бъде използван само веднъж.
            </p>
            <p className="text-sm text-green-700">
              Изпратихме и известие на текущия Ви адрес{" "}
              <span className="font-medium">{user.email}</span> — ако не
              сте поискали тази смяна, просто го игнорирайте: смяната няма
              да влезе в сила без потвърждаване от новия адрес.
            </p>
            <p className="text-xs text-muted-foreground pt-2">
              Не намирате имейла? Проверете папката „Спам“ на новия адрес.
              Имейлът може да отнеме до няколко минути.
            </p>
            <div className="pt-2">
              <ButtonLink href="/account/profile" variant="outline" size="sm">
                Към профила
              </ButtonLink>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <div>
              <Label htmlFor="newEmail">Нов имейл адрес</Label>
              <Input
                id="newEmail"
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                autoComplete="email"
                required
                className="mt-1"
                placeholder="new@example.com"
                disabled={pending}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Ще изпратим линк за потвърждаване на този адрес. Смяната
                ще влезе в сила, след като го отворите.
              </p>
            </div>
            <div>
              <Label htmlFor="currentPassword">Текуща парола</Label>
              <Input
                id="currentPassword"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
                required
                className="mt-1"
                disabled={pending}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Изискваме паролата Ви като допълнителна защита срещу
                неоторизирана смяна на акаунта.
              </p>
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
              {pending ? "Изпращане..." : "Изпрати линк за потвърждаване"}
            </Button>

            <p className="text-xs text-muted-foreground pt-2">
              След като потвърдите смяната от новия адрес, всички активни
              сесии ще бъдат прекратени и ще трябва да влезете отново с
              новия имейл.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
