"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, MapPin, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/AuthContext";
import {
  createAddress,
  deleteAddress,
  listAddresses,
  updateAddress,
} from "@/lib/addresses/client";
import type {
  Address,
  AddressError,
  CreateAddressInput,
} from "@/lib/addresses/types";

/**
 * /account/addresses — the customer address book ("адресна книга", spec §6).
 *
 * Account-holders keep a set of delivery addresses they can reuse. There is
 * deliberately NO default address (the spec has the customer pick explicitly
 * at checkout), so the book is an unordered set of equals — every entry has
 * the same Edit / Delete affordances and none is "primary".
 *
 * Wired to the /addresses CRUD on shop-api. The form is reused for both
 * create and edit (editingId === null → create). Delete uses an inline
 * two-step confirm rather than a window.confirm (CSP-friendly + accessible).
 */

type FormErrors = {
  label?: string;
  city?: string;
  postalCode?: string;
  street?: string;
  apartmentOrOffice?: string;
  form?: string;
};

const POSTAL_CODE_RE = /^\d{4}$/;

/** Map a server AddressError onto per-field + form-level UI strings (Bulgarian). */
function toFormErrors(err: AddressError): FormErrors {
  switch (err.kind) {
    case "validation": {
      const out: FormErrors = {};
      for (const f of err.fields) {
        switch (f.path) {
          case "city":
            out.city = "Градът е задължителен.";
            break;
          case "postalCode":
            out.postalCode = "Пощенският код трябва да е точно 4 цифри.";
            break;
          case "street":
            out.street = "Улицата е задължителна.";
            break;
          case "label":
            out.label = "Етикетът е твърде дълъг (макс. 60 символа).";
            break;
          case "apartmentOrOffice":
            out.apartmentOrOffice = "Стойността е твърде дълга (макс. 120 символа).";
            break;
          default:
            out.form ??= f.message;
        }
      }
      if (!Object.keys(out).length) {
        out.form = err.detail ?? "Моля проверете въведените данни.";
      }
      return out;
    }
    case "limit_reached":
      return {
        form: "Достигнахте максималния брой запазени адреси (20). Изтрийте някой, за да добавите нов.",
      };
    case "not_found":
      return { form: "Адресът вече не съществува. Презаредете страницата." };
    case "unauthenticated":
      return { form: "Сесията Ви е изтекла. Моля, влезте отново." };
    case "network":
      return { form: "Възникна мрежова грешка. Моля, опитайте отново." };
    default:
      return {
        form: err.detail ?? "Възникна неочаквана грешка. Моля, опитайте отново.",
      };
  }
}

export default function AddressesPage() {
  const router = useRouter();
  const { status } = useAuth();

  const [addresses, setAddresses] = useState<Address[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Form state — shared between create and edit.
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [fLabel, setFLabel] = useState("");
  const [fCity, setFCity] = useState("");
  const [fPostalCode, setFPostalCode] = useState("");
  const [fStreet, setFStreet] = useState("");
  const [fApartment, setFApartment] = useState("");
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitting, setSubmitting] = useState(false);

  // Inline delete confirmation: the id currently awaiting a "yes, delete".
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await listAddresses();
    if (res.ok) {
      setAddresses(res.value);
      setLoadError(null);
    } else if (res.error.kind === "unauthenticated") {
      router.replace("/account/login?next=/account/addresses");
    } else {
      setLoadError(
        "Неуспешно зареждане на адресите. Опитайте да презаредите страницата.",
      );
    }
    setLoading(false);
  }, [router]);

  // Initial load. Inlined as an async IIFE (rather than calling `refresh`)
  // so the setState calls sit after a lexically-visible `await` — the
  // `react-hooks/set-state-in-effect` rule rejects synchronously calling a
  // setState-bearing callback straight from an effect. `refresh` is still
  // used by the create/edit/delete handlers (event handlers, where setState
  // is fine). Same IIFE+cancelled-guard pattern as /account/profile.
  useEffect(() => {
    if (status === "anonymous") {
      router.replace("/account/login?next=/account/addresses");
      return;
    }
    if (status !== "authenticated") return;
    let cancelled = false;
    void (async () => {
      const res = await listAddresses();
      if (cancelled) return;
      if (res.ok) {
        setAddresses(res.value);
        setLoadError(null);
      } else if (res.error.kind === "unauthenticated") {
        router.replace("/account/login?next=/account/addresses");
      } else {
        setLoadError(
          "Неуспешно зареждане на адресите. Опитайте да презаредите страницата.",
        );
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [status, router]);

  if (status !== "authenticated") {
    return (
      <div className="max-w-2xl mx-auto px-4 py-12 text-center text-sm text-muted-foreground">
        Зареждане...
      </div>
    );
  }

  function resetForm() {
    setEditingId(null);
    setFLabel("");
    setFCity("");
    setFPostalCode("");
    setFStreet("");
    setFApartment("");
    setErrors({});
  }

  function openCreate() {
    resetForm();
    setShowForm(true);
    setSuccessMsg(null);
  }

  function openEdit(a: Address) {
    setEditingId(a.id);
    setFLabel(a.label ?? "");
    setFCity(a.city);
    setFPostalCode(a.postalCode);
    setFStreet(a.street);
    setFApartment(a.apartmentOrOffice ?? "");
    setErrors({});
    setShowForm(true);
    setSuccessMsg(null);
  }

  function closeForm() {
    setShowForm(false);
    resetForm();
  }

  function validateClient(): FormErrors {
    const e: FormErrors = {};
    if (!fCity.trim()) e.city = "Градът е задължителен.";
    if (!fPostalCode.trim()) {
      e.postalCode = "Пощенският код е задължителен.";
    } else if (!POSTAL_CODE_RE.test(fPostalCode.trim())) {
      e.postalCode = "Пощенският код трябва да е точно 4 цифри (напр. 1000).";
    }
    if (!fStreet.trim()) e.street = "Улицата е задължителна.";
    return e;
  }

  async function handleSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    setSuccessMsg(null);

    const clientErrors = validateClient();
    if (Object.keys(clientErrors).length > 0) {
      setErrors(clientErrors);
      return;
    }
    setErrors({});

    // `label` / `apartmentOrOffice` empty → null (clear). The backend trims
    // and applies the same collapse, but sending null is the explicit intent.
    const payload: CreateAddressInput = {
      label: fLabel.trim() ? fLabel.trim() : null,
      city: fCity.trim(),
      postalCode: fPostalCode.trim(),
      street: fStreet.trim(),
      apartmentOrOffice: fApartment.trim() ? fApartment.trim() : null,
    };

    setSubmitting(true);
    const res = editingId
      ? await updateAddress(editingId, payload)
      : await createAddress(payload);
    setSubmitting(false);

    if (res.ok) {
      setSuccessMsg(editingId ? "Адресът е обновен." : "Адресът е добавен.");
      closeForm();
      await refresh();
      return;
    }

    const mapped = toFormErrors(res.error);
    setErrors(mapped);
    if (res.error.kind === "unauthenticated") {
      router.replace("/account/login?next=/account/addresses");
    }
  }

  async function handleDelete(id: string) {
    setDeletingId(id);
    const res = await deleteAddress(id);
    setDeletingId(null);
    setConfirmingDeleteId(null);
    if (res.ok) {
      setSuccessMsg("Адресът е изтрит.");
      await refresh();
      return;
    }
    if (res.error.kind === "unauthenticated") {
      router.replace("/account/login?next=/account/addresses");
      return;
    }
    // not_found (already gone) → just refresh to reconcile the list.
    setLoadError(
      res.error.kind === "not_found"
        ? null
        : "Неуспешно изтриване на адреса. Опитайте отново.",
    );
    await refresh();
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-10">
      <ButtonLink
        variant="ghost"
        size="sm"
        href="/account/profile"
        className="gap-1.5 mb-6 -ml-2"
      >
        <ArrowLeft className="w-4 h-4" /> Обратно към профила
      </ButtonLink>

      <div className="flex items-center justify-between mb-2">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <MapPin className="w-6 h-6 text-primary-strong" /> Адресна книга
        </h1>
        {!showForm && (
          <Button size="sm" className="gap-1.5" onClick={openCreate}>
            <Plus className="w-4 h-4" /> Добави адрес
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        Запазете адресите за доставка, които ползвате най-често. При поръчка ще
        можете да изберете някой от тях или да въведете нов.
      </p>

      {successMsg && (
        <p
          role="status"
          aria-live="polite"
          className="mb-4 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800"
        >
          {successMsg}
        </p>
      )}

      {loadError && (
        <p
          role="alert"
          className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {loadError}
        </p>
      )}

      {/* Create / edit form */}
      {showForm && (
        <form
          onSubmit={(e) => void handleSubmit(e)}
          className="mb-8 rounded-lg border border-border p-5 space-y-4"
          noValidate
        >
          <h2 className="font-semibold">
            {editingId ? "Редактиране на адрес" : "Нов адрес"}
          </h2>

          <div>
            <Label htmlFor="label">Етикет (по избор)</Label>
            <Input
              id="label"
              className="mt-1"
              placeholder="напр. Вкъщи, Офис"
              value={fLabel}
              onChange={(e) => setFLabel(e.target.value)}
              disabled={submitting}
              maxLength={60}
              aria-invalid={errors.label ? true : undefined}
            />
            {errors.label && (
              <p className="mt-1 text-sm text-red-600">{errors.label}</p>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-2">
              <Label htmlFor="city">Град</Label>
              <Input
                id="city"
                className="mt-1"
                value={fCity}
                onChange={(e) => setFCity(e.target.value)}
                disabled={submitting}
                maxLength={120}
                autoComplete="address-level2"
                aria-invalid={errors.city ? true : undefined}
                aria-describedby={errors.city ? "city-error" : undefined}
              />
              {errors.city && (
                <p id="city-error" className="mt-1 text-sm text-red-600">
                  {errors.city}
                </p>
              )}
            </div>
            <div>
              <Label htmlFor="postalCode">Пощенски код</Label>
              <Input
                id="postalCode"
                className="mt-1"
                inputMode="numeric"
                placeholder="1000"
                value={fPostalCode}
                onChange={(e) => setFPostalCode(e.target.value)}
                disabled={submitting}
                maxLength={4}
                autoComplete="postal-code"
                aria-invalid={errors.postalCode ? true : undefined}
                aria-describedby={
                  errors.postalCode ? "postalCode-error" : "postalCode-hint"
                }
              />
              {errors.postalCode ? (
                <p id="postalCode-error" className="mt-1 text-sm text-red-600">
                  {errors.postalCode}
                </p>
              ) : (
                <p id="postalCode-hint" className="mt-1 text-xs text-muted-foreground">
                  4 цифри
                </p>
              )}
            </div>
          </div>

          <div>
            <Label htmlFor="street">Улица и номер</Label>
            <Input
              id="street"
              className="mt-1"
              placeholder="бул. Витоша 1"
              value={fStreet}
              onChange={(e) => setFStreet(e.target.value)}
              disabled={submitting}
              maxLength={240}
              autoComplete="address-line1"
              aria-invalid={errors.street ? true : undefined}
              aria-describedby={errors.street ? "street-error" : undefined}
            />
            {errors.street && (
              <p id="street-error" className="mt-1 text-sm text-red-600">
                {errors.street}
              </p>
            )}
          </div>

          <div>
            <Label htmlFor="apartment">Апартамент / офис (по избор)</Label>
            <Input
              id="apartment"
              className="mt-1"
              placeholder="ап. 5, ет. 2"
              value={fApartment}
              onChange={(e) => setFApartment(e.target.value)}
              disabled={submitting}
              maxLength={120}
              autoComplete="address-line2"
              aria-invalid={errors.apartmentOrOffice ? true : undefined}
            />
            {errors.apartmentOrOffice && (
              <p className="mt-1 text-sm text-red-600">
                {errors.apartmentOrOffice}
              </p>
            )}
          </div>

          {errors.form && (
            <div
              role="alert"
              className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              {errors.form}
            </div>
          )}

          <div className="flex gap-3 pt-1">
            <Button type="submit" disabled={submitting}>
              {submitting
                ? "Записване..."
                : editingId
                  ? "Запази промените"
                  : "Запази адреса"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={closeForm}
              disabled={submitting}
            >
              Отказ
            </Button>
          </div>
        </form>
      )}

      {/* Address list */}
      {loading ? (
        <p className="text-sm text-muted-foreground">Зареждане на адресите...</p>
      ) : addresses.length === 0 ? (
        !showForm && (
          <div className="rounded-lg border border-dashed border-border p-8 text-center">
            <MapPin className="w-8 h-8 mx-auto text-muted-foreground/60 mb-2" />
            <p className="text-sm text-muted-foreground">
              Нямате запазени адреси все още.
            </p>
            <Button size="sm" className="mt-4 gap-1.5" onClick={openCreate}>
              <Plus className="w-4 h-4" /> Добави първия си адрес
            </Button>
          </div>
        )
      ) : (
        <ul className="space-y-3">
          {addresses.map((a) => (
            <li
              key={a.id}
              className="rounded-lg border border-border p-4 flex items-start justify-between gap-4"
            >
              <div className="min-w-0">
                {a.label && (
                  <p className="font-medium truncate">{a.label}</p>
                )}
                <p className="text-sm">
                  {a.street}
                  {a.apartmentOrOffice ? `, ${a.apartmentOrOffice}` : ""}
                </p>
                <p className="text-sm text-muted-foreground">
                  {a.postalCode} {a.city}
                </p>
              </div>

              <div className="flex flex-col items-end gap-2 shrink-0">
                {confirmingDeleteId === a.id ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      Сигурни ли сте?
                    </span>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => void handleDelete(a.id)}
                      disabled={deletingId === a.id}
                    >
                      {deletingId === a.id ? "..." : "Да, изтрий"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirmingDeleteId(null)}
                      disabled={deletingId === a.id}
                    >
                      Отказ
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="gap-1.5"
                      onClick={() => openEdit(a)}
                      aria-label={`Редактирай адрес${a.label ? ` ${a.label}` : ""}`}
                    >
                      <Pencil className="w-4 h-4" /> Редактирай
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="gap-1.5 text-red-600 hover:text-red-700"
                      onClick={() => setConfirmingDeleteId(a.id)}
                      aria-label={`Изтрий адрес${a.label ? ` ${a.label}` : ""}`}
                    >
                      <Trash2 className="w-4 h-4" /> Изтрий
                    </Button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
