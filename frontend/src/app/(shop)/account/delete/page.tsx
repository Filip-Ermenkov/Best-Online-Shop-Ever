"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/AuthContext";
import { useCart } from "@/contexts/CartContext";
import { deleteAccount } from "@/lib/auth/client";

/**
 * /account/delete
 *
 * GDPR Art. 17 right-to-erasure flow. The page deliberately follows the
 * 2026 SaaS destructive-action convention:
 *
 *   1. Big, plain explanation of what gets deleted vs what is legally
 *      retained. The Bulgarian Accountancy Act mandates 10-year retention
 *      for invoices, which means order rows survive (pseudonymised). The
 *      copy says this in plain Bulgarian, no legalese.
 *
 *   2. Typed confirmation phrase ("ИЗТРИЙ" — Bulgarian for "DELETE"). This
 *      is the canonical SaaS pattern (Stripe, GitHub, Vercel all use a
 *      variant). Locks against a mis-clicked DELETE — the backend Zod
 *      schema is z.literal("ИЗТРИЙ") so any other value gets a 400.
 *
 *   3. Current-password re-auth. Defeats the stolen-cookie threat —
 *      consistent with /account/email-change and /account/profile's
 *      password-change section.
 *
 *   4. On success: clear local cart state, log out, redirect to the
 *      homepage with a `?account-deleted=success` query-string flag that
 *      shows a confirmation banner. The session cookie is already cleared
 *      by the API's `Set-Cookie` header on the 204 response; the
 *      AuthContext logout() call also wipes server-side residue and the
 *      local user state.
 *
 *   5. Active-order rejection: if there are orders still in flight, the
 *      API returns 422 with the blocking order numbers. We render them
 *      as a list with a clear "wait for these to complete, or contact
 *      support to cancel" instruction.
 */

export default function DeleteAccountPage() {
  const router = useRouter();
  const { user, status, logout } = useAuth();
  const { clearCart } = useCart();

  const [currentPassword, setCurrentPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockingOrders, setBlockingOrders] = useState<string[] | null>(null);

  // Client-side gate. The proxy.ts cookie-presence check is the real
  // protection; this handles the case where the user navigated here
  // directly after their session expired in another tab.
  useEffect(() => {
    if (status === "anonymous") {
      router.replace("/account/login?next=/account/delete");
    }
  }, [status, router]);

  if (status !== "authenticated" || !user) {
    return (
      <div className="max-w-md mx-auto px-4 py-12 text-center text-sm text-muted-foreground">
        Зареждане...
      </div>
    );
  }

  // Admin self-deletion via this endpoint is rejected by the API (see
  // ARCHITECTURE.md §12.4 — the single admin account has its own MFA
  // recovery runbook). Render an explicit message rather than letting
  // the form submit and surface a 403.
  if (user.role !== "customer") {
    return (
      <div className="max-w-md mx-auto px-4 py-12 space-y-4">
        <ButtonLink
          variant="ghost"
          size="sm"
          href="/account/profile"
          className="gap-1.5 -ml-2"
        >
          <ArrowLeft className="w-4 h-4" /> Обратно към профила
        </ButtonLink>
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700"
        >
          Администраторският акаунт не може да бъде изтрит през тази
          страница. Свържете се с поддръжката, ако е необходимо.
        </div>
      </div>
    );
  }

  // Submit gating: confirmation must be EXACTLY the locked phrase, the
  // password field must be non-empty. The backend re-validates both;
  // this is purely UX — disables the button until inputs look plausible.
  const canSubmit =
    confirmation === "ИЗТРИЙ" && currentPassword.length > 0 && !pending;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBlockingOrders(null);

    if (confirmation !== "ИЗТРИЙ") {
      setError(
        "Потвърдителната дума трябва да е точно „ИЗТРИЙ“ (с главни букви).",
      );
      return;
    }
    if (!currentPassword) {
      setError("Моля въведете текущата си парола.");
      return;
    }

    setPending(true);
    try {
      const res = await deleteAccount({
        currentPassword,
        confirmationPhrase: "ИЗТРИЙ",
      });
      if (!res.ok) {
        switch (res.error.kind) {
          case "invalid_credentials":
            setError("Текущата парола е грешна.");
            return;
          case "account_locked":
            setError(
              "Твърде много неуспешни опити. Моля изчакайте 15 минути и опитайте отново.",
            );
            return;
          case "active_orders_block_deletion":
            setBlockingOrders(res.error.orderNumbers);
            return;
          case "validation":
            setError(
              res.error.fields[0]?.message ??
                "Моля проверете въведените данни.",
            );
            return;
          case "unauthenticated":
            router.replace("/account/login?next=/account/delete");
            return;
          case "network":
            setError(
              "Не може да се свърже със сървъра. Проверете интернет връзката и опитайте отново.",
            );
            return;
          case "unknown":
            if (res.error.status === 403) {
              setError(
                "Този тип акаунт не може да бъде изтрит през тази страница.",
              );
              return;
            }
            setError(
              "Възникна неочаквана грешка. Моля опитайте отново или се свържете с поддръжката.",
            );
            return;
          default:
            setError(
              "Възникна неочаквана грешка. Моля опитайте отново или се свържете с поддръжката.",
            );
            return;
        }
      }

      // ── Success ──────────────────────────────────────────────────────
      // The API's 204 response already carried Set-Cookie: Max-Age=0 to
      // wipe the session cookie. We still call logout() locally so the
      // AuthContext drops its in-memory user state immediately (without
      // waiting for the next /auth/me call) and to invoke the same
      // server-side /auth/logout idempotently — defence in depth.
      try {
        await logout();
      } catch {
        // logout() never throws on the 204/anonymous path, but the
        // typing allows it. Swallow — the user IS deleted regardless.
      }
      // Clear local cart UI — the server cart was wiped in the
      // transaction; this just makes the drawer reflect the truth
      // without a reload.
      try {
        await clearCart();
      } catch {
        // Same posture: clearCart can fail on a transient network blip
        // after the session is already gone; not a reason to keep the
        // user on this page.
      }
      router.replace("/?account-deleted=success");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-lg">
        <ButtonLink
          variant="ghost"
          size="sm"
          href="/account/profile"
          className="gap-1.5 mb-6 -ml-2"
        >
          <ArrowLeft className="w-4 h-4" /> Обратно към профила
        </ButtonLink>

        <div className="mb-6">
          <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center mb-4">
            <AlertTriangle className="w-6 h-6 text-red-600" />
          </div>
          <h1 className="text-2xl font-bold">Изтриване на акаунт</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Акаунт:{" "}
            <span className="font-medium text-foreground">{user.email}</span>
          </p>
        </div>

        {/* What gets deleted */}
        <section className="mb-6">
          <h2 className="text-sm font-semibold mb-2">Какво ще бъде изтрито:</h2>
          <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-1">
            <li>Профилните Ви данни (име, телефон, фирмени данни)</li>
            <li>Адресите от адресния Ви бележник</li>
            <li>Кошницата Ви</li>
            <li>Активните Ви сесии на всички устройства</li>
            <li>
              Имейл адресът Ви ще бъде освободен — можете да се регистрирате
              наново със същия адрес
            </li>
          </ul>
        </section>

        {/* What is legally retained */}
        <section className="mb-6 rounded-md border border-amber-200 bg-amber-50 p-4">
          <h2 className="text-sm font-semibold text-amber-900 mb-2">
            Какво се запазва по закон:
          </h2>
          <p className="text-sm text-amber-800 leading-relaxed">
            Историята на поръчките Ви се запазва, но свързаните с Вас лични
            данни в нея ще бъдат псевдонимизирани. Законът за счетоводството
            на Република България изисква 10-годишен срок на съхранение за
            фактури и счетоводни документи (чл. 12). Тази правна задължителност
            има предимство пред правото на изтриване по чл. 17(3)(б) от GDPR.
          </p>
        </section>

        {/* Active-orders rejection display */}
        {blockingOrders && blockingOrders.length > 0 && (
          <div
            role="alert"
            aria-live="polite"
            className="mb-6 rounded-md border border-red-200 bg-red-50 p-4 space-y-3"
          >
            <p className="text-sm font-semibold text-red-700">
              Не може да изтриете акаунта си в момента
            </p>
            <p className="text-sm text-red-700">
              Имате поръчки, които са в процес на изпълнение. Изтриването
              е възможно едва след като всички поръчки приключат (доставени
              и приети, върнати, или отменени).
            </p>
            <p className="text-sm text-red-700 font-medium">
              Поръчки, които блокират изтриването:
            </p>
            <ul className="list-disc pl-5 text-sm text-red-700 space-y-1">
              {blockingOrders.map((orderNumber) => (
                <li key={orderNumber}>
                  <a
                    href={`/account/orders/${encodeURIComponent(orderNumber)}`}
                    className="font-medium underline"
                  >
                    Поръчка №{orderNumber}
                  </a>
                </li>
              ))}
            </ul>
            <p className="text-xs text-red-700 pt-1">
              Изчакайте всички да приключат, или се свържете с поддръжката,
              ако желаете да ги отмените.
            </p>
          </div>
        )}

        {/* Final warning */}
        <div
          className="mb-6 rounded-md border border-red-300 bg-red-50 p-4"
          role="note"
        >
          <p className="text-sm font-semibold text-red-700 mb-1">
            Това действие е необратимо.
          </p>
          <p className="text-sm text-red-700">
            След като натиснете „Изтрий акаунта“, всички данни по-горе ще
            бъдат изтрити незабавно и не могат да бъдат възстановени.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div>
            <Label htmlFor="confirmation">
              Напишете <span className="font-mono font-bold">ИЗТРИЙ</span>{" "}
              за потвърждение
            </Label>
            <Input
              id="confirmation"
              type="text"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              required
              className="mt-1 font-mono"
              placeholder="ИЗТРИЙ"
              disabled={pending}
              aria-describedby="confirmation-hint"
            />
            <p id="confirmation-hint" className="mt-1 text-xs text-muted-foreground">
              С главни букви, точно както е показано.
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
              Изискваме паролата Ви като защита срещу неоторизирано изтриване.
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

          <div className="flex gap-3 pt-2">
            <ButtonLink
              href="/account/profile"
              variant="outline"
              className="flex-1"
            >
              Отказ
            </ButtonLink>
            <Button
              type="submit"
              variant="destructive"
              disabled={!canSubmit}
              className="flex-1"
            >
              {pending ? "Изтриване..." : "Изтрий акаунта"}
            </Button>
          </div>
        </form>

        <p className="text-xs text-muted-foreground mt-6">
          След изтриването ще получите потвърждаващ имейл на адреса{" "}
          <span className="font-medium">{user.email}</span>. Ако имате
          въпроси, можете да се свържете с поддръжката преди да продължите.
        </p>
      </div>
    </div>
  );
}
