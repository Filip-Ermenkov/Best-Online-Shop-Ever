"use client";

import { useAuth } from "@/contexts/AuthContext";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Package } from "lucide-react";
import { changePassword } from "@/lib/auth/client";
import type { AuthError } from "@/lib/auth/types";

/**
 * Inline-error state for the password-change form. We keep one slot per
 * input plus a top-level slot for "the whole form failed for a reason that
 * isn't attached to any single field" (e.g., account_locked, network).
 *
 * Splitting per-input lets the form render the right red message next to
 * the right control — the same UX pattern register / reset-password use.
 */
type PasswordFormErrors = {
  currentPassword?: string;
  newPassword?: string;
  confirmNewPassword?: string;
  form?: string;
};

/**
 * Map a server AuthError into per-field UI strings (in Bulgarian).
 *
 * Decoupled from the form component so the table of "which kinds fall onto
 * which inputs" is a single readable function — easier to audit + easier
 * to extend if a future server error type lands.
 */
function authErrorToPasswordFormErrors(err: AuthError): PasswordFormErrors {
  switch (err.kind) {
    case "validation":
      // Length / shape failures on newPassword arrive as a 400 with
      // errors[].path === "newPassword". Map them to the right input.
      // Anything we can't map falls into the form-level slot.
      return mapFieldErrors(err.fields, err.detail);
    case "breached_password":
      return {
        newPassword:
          "Тази парола е била включена в известен пробив в данни. Моля, изберете различна парола.",
      };
    case "same_password":
      return {
        newPassword: "Новата парола трябва да е различна от текущата.",
      };
    case "invalid_credentials":
      // The backend's only 401 here is "wrong current password" (the
      // session was already validated by requireAuth). Anchor the error
      // to the currentPassword input.
      return {
        currentPassword: "Грешна текуща парола.",
      };
    case "account_locked":
      return {
        form: "Твърде много неуспешни опита. Опитайте отново след 15 минути.",
      };
    case "unauthenticated":
      return {
        form: "Сесията Ви е изтекла. Моля, влезте отново.",
      };
    case "network":
      return {
        form: "Възникна мрежова грешка. Моля, опитайте отново.",
      };
    case "unknown":
      return {
        form: err.detail ?? "Възникна неочаквана грешка. Моля, опитайте отново.",
      };
    // Token-based kinds (invalid_reset_token, invalid_email_change_token)
    // can't surface here — change-password doesn't take a token. Fall
    // through to a generic form-level message so the UI is never blank.
    default:
      return {
        form: "Възникна неочаквана грешка. Моля, опитайте отново.",
      };
  }
}

function mapFieldErrors(
  fields: { path: string; message: string }[],
  fallbackDetail?: string,
): PasswordFormErrors {
  const out: PasswordFormErrors = {};
  for (const f of fields) {
    if (f.path === "currentPassword") out.currentPassword = f.message;
    else if (f.path === "newPassword") {
      // The server message is English ("Password must be at least 12 chars…")
      // — replace with localized copy on the known length-floor case.
      out.newPassword = /12/.test(f.message)
        ? "Паролата трябва да е поне 12 символа."
        : f.message;
    } else {
      // Unknown field path — surface at form level rather than discard.
      out.form ??= f.message;
    }
  }
  if (!Object.keys(out).length && fallbackDetail) {
    out.form = fallbackDetail;
  }
  return out;
}

export default function ProfilePage() {
  const { user, status, logout } = useAuth();
  const router = useRouter();
  const [saved, setSaved] = useState(false);

  // Password-change form state. Kept local to this page (not lifted into
  // AuthContext) because no other component cares about the half-typed
  // password. Cleared on submit success.
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [pwErrors, setPwErrors] = useState<PasswordFormErrors>({});
  const [pwSubmitting, setPwSubmitting] = useState(false);
  const [pwSuccess, setPwSuccess] = useState(false);

  // Client-side gate. Real protection is in proxy.ts (cookie-presence check)
  // — by the time we get here, the cookie almost always exists. The
  // status === "loading" path covers the brief race where the page mounted
  // before AuthContext finished its /auth/me fetch.
  useEffect(() => {
    if (status === "anonymous") router.replace("/account/login");
  }, [status, router]);

  if (status !== "authenticated" || !user) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-10 text-center text-sm text-muted-foreground">
        Зареждане...
      </div>
    );
  }

  // Personal-data editing isn't wired to a backend endpoint yet — there's
  // no PATCH /auth/me. Until that ships, the form is client-side-only and
  // shows a toast on save without persisting. Marked as such so it's
  // obvious to the next slice owner what's missing.
  function handleSavePersonal(e: React.FormEvent) {
    e.preventDefault();
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  /**
   * Submit the password-change form.
   *
   * Two layers of validation. Client-side runs first (synchronous, cheap):
   *   - all three inputs non-empty,
   *   - newPassword ≥ 12 chars (mirrors backend Zod min),
   *   - confirmNewPassword === newPassword.
   * Then the server is the source of truth — HIBP, same-password, current-
   * password verify all happen there.
   */
  async function handleSubmitPassword(e: React.FormEvent) {
    e.preventDefault();
    setPwSuccess(false);

    const clientErrs: PasswordFormErrors = {};
    if (!currentPassword) {
      clientErrs.currentPassword = "Моля, въведете текущата парола.";
    }
    if (!newPassword) {
      clientErrs.newPassword = "Моля, въведете нова парола.";
    } else if (newPassword.length < 12) {
      clientErrs.newPassword = "Паролата трябва да е поне 12 символа.";
    }
    if (confirmNewPassword !== newPassword) {
      clientErrs.confirmNewPassword = "Двете нови пароли не съвпадат.";
    }
    if (Object.keys(clientErrs).length > 0) {
      setPwErrors(clientErrs);
      return;
    }

    setPwErrors({});
    setPwSubmitting(true);
    const result = await changePassword({ currentPassword, newPassword });
    setPwSubmitting(false);

    if (result.ok) {
      // Clear the inputs so a "shoulder-surfer" can't reconstruct the
      // password from a left-open tab. The server has dropped other
      // sessions; THIS session continues working — no redirect needed.
      setCurrentPassword("");
      setNewPassword("");
      setConfirmNewPassword("");
      setPwSuccess(true);
      // Auto-dismiss the success banner after a few seconds so it
      // doesn't sit indefinitely after the user has moved on.
      setTimeout(() => setPwSuccess(false), 5000);
      return;
    }

    const mapped = authErrorToPasswordFormErrors(result.error);
    setPwErrors(mapped);
    // If the server says the session is dead (unauthenticated), bounce to
    // login — the user can't recover from this page.
    if (result.error.kind === "unauthenticated") {
      router.replace("/account/login");
    }
  }

  // The backend stores a single `fullName`. The form historically split
  // it into first/last for editing — we keep that UX by splitting on the
  // first space, but the round-trip is a no-op until profile-edit lands.
  const initial = (user.fullName ?? user.email)[0]?.toUpperCase() ?? "?";
  const [firstName, ...rest] = (user.fullName ?? "").split(/\s+/);
  const lastName = rest.join(" ");

  return (
    <div className="max-w-2xl mx-auto px-4 py-10">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Моят профил</h1>
        <div className="flex items-center gap-2">
          <ButtonLink variant="outline" size="sm" className="gap-2" href="/account/orders">
            <Package className="w-4 h-4" /> Поръчки
          </ButtonLink>
          <Button variant="ghost" size="sm" onClick={() => { void logout().then(() => router.push("/")); }}>
            Изход
          </Button>
        </div>
      </div>

      <div className="rounded-lg border border-border p-5 mb-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-lg">
            {initial}
          </div>
          <div>
            <p className="font-semibold">{user.fullName ?? user.email}</p>
            <p className="text-sm text-muted-foreground">{user.email}</p>
          </div>
          <div className="ml-auto flex gap-2">
            {user.accountType && (
              <Badge variant="outline">
                {user.accountType === "corporate" ? "Фирма" : "Физическо лице"}
              </Badge>
            )}
          </div>
        </div>
      </div>

      {/* Personal-data form — still a client-only stub until PATCH /auth/me lands. */}
      <form onSubmit={handleSavePersonal} className="space-y-4">
        <h2 className="font-semibold">Лични данни</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="firstName">Име</Label>
            <Input id="firstName" defaultValue={firstName ?? ""} className="mt-1" />
          </div>
          <div>
            <Label htmlFor="lastName">Фамилия</Label>
            <Input id="lastName" defaultValue={lastName} className="mt-1" />
          </div>
        </div>
        <div>
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" defaultValue={user.email} className="mt-1" disabled />
          <p className="mt-1 text-xs text-muted-foreground">
            За промяна на имейл адреса{" "}
            <a
              href="/account/email-change"
              className="text-primary hover:underline"
            >
              кликнете тук
            </a>
            . Ще изпратим линк за потвърждаване на новия адрес.
          </p>
        </div>
        <div>
          <Label htmlFor="phone">Телефон</Label>
          <Input id="phone" type="tel" className="mt-1" placeholder="+359 88 ..." />
        </div>

        <div className="flex items-center gap-3 pt-2">
          <Button type="submit">Запази промените</Button>
          {saved && <p className="text-sm text-green-600">Записано успешно!</p>}
        </div>
        <p className="text-xs text-muted-foreground">
          Промените на личните данни все още не се записват — този endpoint ще бъде наличен в следваща версия.
        </p>
      </form>

      <Separator className="my-8" />

      {/* Password-change form — wired to POST /auth/change-password. */}
      <form onSubmit={(e) => void handleSubmitPassword(e)} className="space-y-4" noValidate>
        <h2 className="font-semibold">Смяна на парола</h2>

        <div>
          <Label htmlFor="currentPassword">Текуща парола</Label>
          <Input
            id="currentPassword"
            type="password"
            autoComplete="current-password"
            className="mt-1"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            aria-invalid={pwErrors.currentPassword ? true : undefined}
            aria-describedby={pwErrors.currentPassword ? "currentPassword-error" : undefined}
            disabled={pwSubmitting}
          />
          {pwErrors.currentPassword && (
            <p id="currentPassword-error" className="mt-1 text-sm text-red-600">
              {pwErrors.currentPassword}
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="newPassword">Нова парола</Label>
            <Input
              id="newPassword"
              type="password"
              autoComplete="new-password"
              className="mt-1"
              minLength={12}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              aria-invalid={pwErrors.newPassword ? true : undefined}
              aria-describedby={pwErrors.newPassword ? "newPassword-error" : "newPassword-hint"}
              disabled={pwSubmitting}
            />
            {pwErrors.newPassword ? (
              <p id="newPassword-error" className="mt-1 text-sm text-red-600">
                {pwErrors.newPassword}
              </p>
            ) : (
              <p id="newPassword-hint" className="mt-1 text-xs text-muted-foreground">
                Поне 12 символа. Дълга фраза с няколко думи е по-сигурна от къса парола със знаци.
              </p>
            )}
          </div>
          <div>
            <Label htmlFor="confirmNewPassword">Потвърди</Label>
            <Input
              id="confirmNewPassword"
              type="password"
              autoComplete="new-password"
              className="mt-1"
              value={confirmNewPassword}
              onChange={(e) => setConfirmNewPassword(e.target.value)}
              aria-invalid={pwErrors.confirmNewPassword ? true : undefined}
              aria-describedby={pwErrors.confirmNewPassword ? "confirmNewPassword-error" : undefined}
              disabled={pwSubmitting}
            />
            {pwErrors.confirmNewPassword && (
              <p id="confirmNewPassword-error" className="mt-1 text-sm text-red-600">
                {pwErrors.confirmNewPassword}
              </p>
            )}
          </div>
        </div>

        {pwErrors.form && (
          <div
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {pwErrors.form}
          </div>
        )}

        <div className="flex items-center gap-3 pt-2">
          <Button type="submit" disabled={pwSubmitting}>
            {pwSubmitting ? "Записване..." : "Смени паролата"}
          </Button>
          {pwSuccess && (
            <p className="text-sm text-green-600" role="status">
              Паролата е сменена успешно. Всички други устройства са излезли.
            </p>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          При смяна на парола всички други активни сесии (други устройства, други браузъри) ще бъдат автоматично прекратени. Тази сесия остава активна.
        </p>
      </form>
    </div>
  );
}
