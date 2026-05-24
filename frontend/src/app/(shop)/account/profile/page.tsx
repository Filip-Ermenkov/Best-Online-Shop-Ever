"use client";

import { useAuth } from "@/contexts/AuthContext";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Package } from "lucide-react";
import {
  changePassword,
  fetchMyProfile,
  updateProfile,
} from "@/lib/auth/client";
import type { AuthError, Profile, UpdateProfileInput } from "@/lib/auth/types";

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
 * Same per-input + form-level shape for the profile-edit form. Keyed on
 * the union of every editable field so a single map handles both the
 * personal and corporate variants — the rendered form will only ever
 * touch the keys relevant to the user's account type.
 */
type ProfileFormErrors = {
  fullName?: string;
  phone?: string;
  companyName?: string;
  vatNumber?: string;
  registeredAddress?: string;
  mol?: string;
  contactName?: string;
  contactPhone?: string;
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
      return mapPasswordFieldErrors(err.fields, err.detail);
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

function mapPasswordFieldErrors(
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

/**
 * Map a server AuthError from PATCH /auth/me into per-field UI strings.
 *
 * The backend's known failure modes here are: `validation` (Zod failures
 * on length/regex, invalid Bulgarian phone, cross-account-type field,
 * unknown field via .strict()), `unauthenticated` (session died between
 * page load and submit), and the always-possible `network`.
 */
function authErrorToProfileFormErrors(err: AuthError): ProfileFormErrors {
  switch (err.kind) {
    case "validation":
      return mapProfileFieldErrors(err.fields, err.detail);
    case "unauthenticated":
      return { form: "Сесията Ви е изтекла. Моля, влезте отново." };
    case "network":
      return { form: "Възникна мрежова грешка. Моля, опитайте отново." };
    case "unknown":
      return {
        form: err.detail ?? "Възникна неочаквана грешка. Моля, опитайте отново.",
      };
    default:
      return {
        form: "Възникна неочаквана грешка. Моля, опитайте отново.",
      };
  }
}

function mapProfileFieldErrors(
  fields: { path: string; message: string }[],
  fallbackDetail?: string,
): ProfileFormErrors {
  const out: ProfileFormErrors = {};
  for (const f of fields) {
    switch (f.path) {
      case "fullName":
        out.fullName = "Името е задължително (1–120 символа).";
        break;
      case "phone":
        out.phone = /Bulgarian|valid/i.test(f.message)
          ? "Невалиден български телефон. Пример: +359 88 812 3456 или 0888 123 456."
          : f.message;
        break;
      case "companyName":
        out.companyName = "Името на фирмата е задължително.";
        break;
      case "vatNumber":
        out.vatNumber = /BG/.test(f.message)
          ? "Невалиден ДДС номер. Български формат: BG + 9 или 10 цифри."
          : f.message;
        break;
      case "registeredAddress":
        out.registeredAddress = "Адресът на регистрация е задължителен.";
        break;
      case "mol":
        out.mol = "МОЛ е задължително поле.";
        break;
      case "contactName":
        out.contactName = "Името за контакт е задължително.";
        break;
      case "contactPhone":
        out.contactPhone =
          "Невалиден телефон за контакт. Пример: +359 88 812 3456.";
        break;
      default:
        // Unknown path — usually a `.strict()` rejection (e.g., user
        // tried to send a field the server doesn't expose). Show at
        // form level so the user sees something rather than silently
        // failing.
        out.form ??= f.message;
    }
  }
  if (!Object.keys(out).length && fallbackDetail) {
    out.form = fallbackDetail;
  }
  return out;
}

export default function ProfilePage() {
  const { user, status, logout, refresh } = useAuth();
  const router = useRouter();

  // ─── Profile data (loaded once on mount) ─────────────────────────────────
  // AuthContext only carries identity (id, email, role, accountType,
  // fullName). The editable fields (phone, corporate data) live on the
  // sibling `profile` field of GET /auth/me. We fetch that lazily on
  // mount rather than adding it to AuthContext, because no other page
  // needs it and storing it globally would mean every navigation re-reads
  // it just to discard it.
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileLoadError, setProfileLoadError] = useState<string | null>(null);

  // Form state — initialized from `profile` once it loads. Tracked as
  // strings even for nullable corporate fields so the inputs are always
  // controlled; we serialize "" → null only for vatNumber at submit time.
  const [formFullName, setFormFullName] = useState("");
  const [formPhone, setFormPhone] = useState("");
  const [formCompanyName, setFormCompanyName] = useState("");
  const [formVatNumber, setFormVatNumber] = useState("");
  const [formRegisteredAddress, setFormRegisteredAddress] = useState("");
  const [formMol, setFormMol] = useState("");
  const [formContactName, setFormContactName] = useState("");
  const [formContactPhone, setFormContactPhone] = useState("");

  const [profileErrors, setProfileErrors] = useState<ProfileFormErrors>({});
  const [profileSubmitting, setProfileSubmitting] = useState(false);
  const [profileSuccess, setProfileSuccess] = useState(false);

  // ─── Password-change form state (unchanged from the May 22 slice) ────────
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [pwErrors, setPwErrors] = useState<PasswordFormErrors>({});
  const [pwSubmitting, setPwSubmitting] = useState(false);
  const [pwSuccess, setPwSuccess] = useState(false);

  // Hydrate form state from a fetched Profile. Extracted so we can re-run
  // it both on initial load and after a successful PATCH (the server's
  // response is the canonical post-write state — it includes the
  // normalised phone, so we always want to mirror server truth).
  const hydrateFromProfile = useCallback((p: Profile | null) => {
    if (!p) {
      setFormFullName("");
      setFormPhone("");
      setFormCompanyName("");
      setFormVatNumber("");
      setFormRegisteredAddress("");
      setFormMol("");
      setFormContactName("");
      setFormContactPhone("");
      return;
    }
    if (p.kind === "personal") {
      setFormFullName(p.fullName);
      setFormPhone(p.phone);
    } else {
      setFormCompanyName(p.companyName);
      setFormVatNumber(p.vatNumber ?? "");
      setFormRegisteredAddress(p.registeredAddress);
      setFormMol(p.mol);
      setFormContactName(p.contactName);
      setFormContactPhone(p.contactPhone);
    }
  }, []);

  // Client-side gate. Real protection is in proxy.ts (cookie-presence check)
  // — by the time we get here, the cookie almost always exists. The
  // status === "loading" path covers the brief race where the page mounted
  // before AuthContext finished its /auth/me fetch.
  useEffect(() => {
    if (status === "anonymous") router.replace("/account/login");
  }, [status, router]);

  // Load the profile once the user is known and authenticated. We don't
  // start the fetch until status === "authenticated" so we don't waste a
  // request on the brief loading window or anonymous bounces.
  useEffect(() => {
    if (status !== "authenticated") return;
    let cancelled = false;
    void (async () => {
      const res = await fetchMyProfile();
      if (cancelled) return;
      if (res.ok) {
        setProfile(res.value);
        hydrateFromProfile(res.value);
        setProfileLoadError(null);
      } else if (res.error.kind === "unauthenticated") {
        router.replace("/account/login");
      } else {
        setProfileLoadError(
          "Неуспешно зареждане на профила. Опитайте да презаредите страницата.",
        );
      }
      setProfileLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [status, hydrateFromProfile, router]);

  if (status !== "authenticated" || !user) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-10 text-center text-sm text-muted-foreground">
        Зареждане...
      </div>
    );
  }

  /**
   * Build a minimal PATCH payload: only fields whose value actually
   * differs from the stored profile. This is also enforced server-side
   * (the no-op short-circuit there compares stored vs incoming), but
   * doing it client-side too means:
   *   - smaller request bodies,
   *   - empty diff → we skip the request entirely and surface "no
   *     changes" instead of a vacuous "saved" toast.
   */
  function buildPatchPayload(): UpdateProfileInput {
    const payload: UpdateProfileInput = {};
    if (!profile) return payload;

    if (profile.kind === "personal") {
      const fn = formFullName.trim();
      if (fn !== profile.fullName) payload.fullName = fn;
      const ph = formPhone.trim();
      if (ph !== profile.phone) payload.phone = ph;
    } else {
      const cn = formCompanyName.trim();
      if (cn !== profile.companyName) payload.companyName = cn;
      // VAT: empty string means "clear"; null is the canonical empty value.
      const v = formVatNumber.trim();
      const incomingVat: string | null = v === "" ? null : v;
      if (incomingVat !== profile.vatNumber) payload.vatNumber = incomingVat;
      const ra = formRegisteredAddress.trim();
      if (ra !== profile.registeredAddress) payload.registeredAddress = ra;
      const mo = formMol.trim();
      if (mo !== profile.mol) payload.mol = mo;
      const con = formContactName.trim();
      if (con !== profile.contactName) payload.contactName = con;
      const cp = formContactPhone.trim();
      if (cp !== profile.contactPhone) payload.contactPhone = cp;
    }
    return payload;
  }

  async function handleSavePersonal(e: React.FormEvent) {
    e.preventDefault();
    setProfileSuccess(false);
    setProfileErrors({});

    const payload = buildPatchPayload();
    if (Object.keys(payload).length === 0) {
      // Nothing changed. Show "no changes" rather than spam the server
      // with a redundant request whose response is already the state we
      // hold locally.
      setProfileErrors({ form: "Няма промени за запазване." });
      return;
    }

    setProfileSubmitting(true);
    const res = await updateProfile(payload);
    setProfileSubmitting(false);

    if (res.ok) {
      setProfile(res.value.profile);
      hydrateFromProfile(res.value.profile);
      setProfileSuccess(true);
      setTimeout(() => setProfileSuccess(false), 4000);
      // If fullName changed, the header in AuthProvider is still showing
      // the old name from the initial /auth/me. Refresh AuthContext so
      // the global identity matches. Other field changes don't affect
      // the header so this is cheap-most-of-the-time anyway.
      if (payload.fullName !== undefined) {
        void refresh();
      }
      return;
    }

    const mapped = authErrorToProfileFormErrors(res.error);
    setProfileErrors(mapped);
    if (res.error.kind === "unauthenticated") {
      router.replace("/account/login");
    }
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

  const initial = (user.fullName ?? user.email)[0]?.toUpperCase() ?? "?";

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

      {/* Profile-edit form — wired to PATCH /auth/me. */}
      {profileLoading ? (
        <div className="text-sm text-muted-foreground">Зареждане на профила...</div>
      ) : profileLoadError ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {profileLoadError}
        </div>
      ) : profile?.kind === "personal" ? (
        <form onSubmit={(e) => void handleSavePersonal(e)} className="space-y-4" noValidate>
          <h2 className="font-semibold">Лични данни</h2>
          <div>
            <Label htmlFor="fullName">Име и фамилия</Label>
            <Input
              id="fullName"
              className="mt-1"
              value={formFullName}
              onChange={(e) => setFormFullName(e.target.value)}
              aria-invalid={profileErrors.fullName ? true : undefined}
              aria-describedby={profileErrors.fullName ? "fullName-error" : undefined}
              disabled={profileSubmitting}
              autoComplete="name"
              maxLength={120}
            />
            {profileErrors.fullName && (
              <p id="fullName-error" className="mt-1 text-sm text-red-600">
                {profileErrors.fullName}
              </p>
            )}
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
            <Input
              id="phone"
              type="tel"
              className="mt-1"
              placeholder="+359 88 812 3456 или 0888 812 345"
              value={formPhone}
              onChange={(e) => setFormPhone(e.target.value)}
              aria-invalid={profileErrors.phone ? true : undefined}
              aria-describedby={profileErrors.phone ? "phone-error" : "phone-hint"}
              disabled={profileSubmitting}
              autoComplete="tel"
              maxLength={40}
            />
            {profileErrors.phone ? (
              <p id="phone-error" className="mt-1 text-sm text-red-600">
                {profileErrors.phone}
              </p>
            ) : (
              <p id="phone-hint" className="mt-1 text-xs text-muted-foreground">
                Български номер. Приема се +359..., 00359... или 0... — записва се в единен формат.
              </p>
            )}
          </div>

          {profileErrors.form && (
            <div
              role="alert"
              className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              {profileErrors.form}
            </div>
          )}

          <div className="flex items-center gap-3 pt-2">
            <Button type="submit" disabled={profileSubmitting}>
              {profileSubmitting ? "Записване..." : "Запази промените"}
            </Button>
            {profileSuccess && (
              <p className="text-sm text-green-600" role="status">
                Записано успешно.
              </p>
            )}
          </div>
        </form>
      ) : profile?.kind === "corporate" ? (
        <form onSubmit={(e) => void handleSavePersonal(e)} className="space-y-4" noValidate>
          <h2 className="font-semibold">Фирмени данни</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="companyName">Име на фирмата</Label>
              <Input
                id="companyName"
                className="mt-1"
                value={formCompanyName}
                onChange={(e) => setFormCompanyName(e.target.value)}
                aria-invalid={profileErrors.companyName ? true : undefined}
                disabled={profileSubmitting}
                autoComplete="organization"
                maxLength={200}
              />
              {profileErrors.companyName && (
                <p className="mt-1 text-sm text-red-600">{profileErrors.companyName}</p>
              )}
            </div>
            <div>
              <Label htmlFor="eik">ЕИК / БУЛСТАТ</Label>
              <Input
                id="eik"
                className="mt-1"
                value={profile.eik}
                disabled
              />
              <p className="mt-1 text-xs text-muted-foreground">
                ЕИК не може да се редактира — това е юридическият идентификатор на фирмата.
              </p>
            </div>
          </div>

          <div>
            <Label htmlFor="vatNumber">ДДС номер</Label>
            <Input
              id="vatNumber"
              className="mt-1"
              placeholder="BG123456789 (по избор)"
              value={formVatNumber}
              onChange={(e) => setFormVatNumber(e.target.value)}
              aria-invalid={profileErrors.vatNumber ? true : undefined}
              disabled={profileSubmitting}
              maxLength={20}
            />
            {profileErrors.vatNumber ? (
              <p className="mt-1 text-sm text-red-600">{profileErrors.vatNumber}</p>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">
                Само за регистрирани по ДДС фирми. Оставете празно ако не сте регистрирани.
              </p>
            )}
          </div>

          <div>
            <Label htmlFor="registeredAddress">Адрес на регистрация</Label>
            <Input
              id="registeredAddress"
              className="mt-1"
              value={formRegisteredAddress}
              onChange={(e) => setFormRegisteredAddress(e.target.value)}
              aria-invalid={profileErrors.registeredAddress ? true : undefined}
              disabled={profileSubmitting}
              autoComplete="street-address"
              maxLength={300}
            />
            {profileErrors.registeredAddress && (
              <p className="mt-1 text-sm text-red-600">{profileErrors.registeredAddress}</p>
            )}
          </div>

          <div>
            <Label htmlFor="mol">МОЛ (Материалноотговорно лице)</Label>
            <Input
              id="mol"
              className="mt-1"
              value={formMol}
              onChange={(e) => setFormMol(e.target.value)}
              aria-invalid={profileErrors.mol ? true : undefined}
              disabled={profileSubmitting}
              maxLength={120}
            />
            {profileErrors.mol && (
              <p className="mt-1 text-sm text-red-600">{profileErrors.mol}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="contactName">Лице за контакт</Label>
              <Input
                id="contactName"
                className="mt-1"
                value={formContactName}
                onChange={(e) => setFormContactName(e.target.value)}
                aria-invalid={profileErrors.contactName ? true : undefined}
                disabled={profileSubmitting}
                autoComplete="name"
                maxLength={120}
              />
              {profileErrors.contactName && (
                <p className="mt-1 text-sm text-red-600">{profileErrors.contactName}</p>
              )}
            </div>
            <div>
              <Label htmlFor="contactPhone">Телефон за контакт</Label>
              <Input
                id="contactPhone"
                type="tel"
                className="mt-1"
                placeholder="+359 88 812 3456"
                value={formContactPhone}
                onChange={(e) => setFormContactPhone(e.target.value)}
                aria-invalid={profileErrors.contactPhone ? true : undefined}
                disabled={profileSubmitting}
                autoComplete="tel"
                maxLength={40}
              />
              {profileErrors.contactPhone && (
                <p className="mt-1 text-sm text-red-600">{profileErrors.contactPhone}</p>
              )}
            </div>
          </div>

          <div>
            <Label htmlFor="email-corp">Email</Label>
            <Input id="email-corp" type="email" defaultValue={user.email} className="mt-1" disabled />
            <p className="mt-1 text-xs text-muted-foreground">
              За промяна на имейл адреса{" "}
              <a
                href="/account/email-change"
                className="text-primary hover:underline"
              >
                кликнете тук
              </a>
              .
            </p>
          </div>

          {profileErrors.form && (
            <div
              role="alert"
              className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              {profileErrors.form}
            </div>
          )}

          <div className="flex items-center gap-3 pt-2">
            <Button type="submit" disabled={profileSubmitting}>
              {profileSubmitting ? "Записване..." : "Запази промените"}
            </Button>
            {profileSuccess && (
              <p className="text-sm text-green-600" role="status">
                Записано успешно.
              </p>
            )}
          </div>
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">
          Този профил няма данни за редакция.
        </p>
      )}

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

      <Separator className="my-8" />

      {/* Danger zone — GDPR Art. 17 right to erasure. Visually de-emphasised
         (no big destructive button on this page) so an accidental click
         can't trigger the destructive flow. The action lives behind a
         link to /account/delete which carries the typed-confirmation +
         re-auth UX. */}
      <section aria-labelledby="danger-zone-heading">
        <h2 id="danger-zone-heading" className="font-semibold text-red-700">
          Изтриване на акаунт
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Можете да изтриете акаунта си изцяло. Профилните данни, адресите,
          кошницата и активните сесии ще бъдат изтрити. Историята на
          поръчките се запазва псевдонимизирана, заради 10-годишния срок
          за съхранение на счетоводни документи.
        </p>
        <div className="mt-3">
          <ButtonLink href="/account/delete" variant="outline" size="sm">
            Изтрий акаунта си
          </ButtonLink>
        </div>
      </section>
    </div>
  );
}
