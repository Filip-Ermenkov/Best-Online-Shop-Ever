"use client";

/**
 * Admin store settings — the real /admin/settings screen
 * (docs/README.md §"Настройки на магазина"): the operator-editable business
 * configuration (contact details, opening hours, default pickup window, admin-
 * notification recipient) that used to live in environment variables and now
 * lives in the runtime-editable `settings` table — so changing the shop phone no
 * longer needs a redeploy (see backend lib/settings.ts for the rationale).
 *
 * Data flows through the typed client in lib/admin/settings/. Only the keys the
 * admin actually changed are sent. A document-level optimistic lock (`version`)
 * guards against a stale second tab clobbering a change → on 409 the form
 * reloads and asks the admin to re-apply. A flat 404 means the admin session
 * expired → router.refresh() re-renders the admin layout's AdminAuthGate (same
 * contract as the other admin managers).
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  fetchAdminSettings,
  updateAdminSettings,
} from "@/lib/admin/settings/client";
import type {
  AdminSettingsError,
  SettingsValues,
} from "@/lib/admin/settings/types";

// ─── Error copy ──────────────────────────────────────────────────────────────

function errorMessage(err: AdminSettingsError): string {
  switch (err.kind) {
    case "version_conflict":
      return "Настройките са променени в друг раздел. Формата е презаредена — приложете промените отново.";
    case "validation":
      return err.fields[0]?.message ?? err.detail ?? "Невалидни данни.";
    case "network":
      return "Връзката със сървъра пропадна. Опитайте отново.";
    case "not_admin":
      return "Сесията изтече. Презаредете страницата.";
    default:
      return err.detail ?? "Възникна неочаквана грешка.";
  }
}

/** Form values are all strings (controlled inputs); days is parsed on submit. */
type FormState = {
  default_pickup_deadline_days: string;
  store_address: string;
  store_hours: string;
  store_phone: string;
  store_email: string;
  admin_notification_email: string;
};

function toForm(v: SettingsValues): FormState {
  return {
    default_pickup_deadline_days: String(v.default_pickup_deadline_days),
    store_address: v.store_address,
    store_hours: v.store_hours,
    store_phone: v.store_phone,
    store_email: v.store_email,
    admin_notification_email: v.admin_notification_email,
  };
}

export default function SettingsManager() {
  const router = useRouter();
  const [form, setForm] = useState<FormState | null>(null);
  const [loaded, setLoaded] = useState<SettingsValues | null>(null);
  const [version, setVersion] = useState<string>("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetchAdminSettings();
      if (cancelled) return;
      if (res.ok) {
        setForm(toForm(res.value.values));
        setLoaded(res.value.values);
        setVersion(res.value.version);
        setLoadError(null);
      } else if (res.error.kind === "not_admin") {
        router.refresh();
      } else {
        setLoadError(errorMessage(res.error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  function set<K extends keyof FormState>(key: K, value: string) {
    setForm((f) => (f ? { ...f, [key]: value } : f));
  }

  /** Build the patch of only the keys that actually changed from `loaded`. */
  function diff(): { values: Partial<SettingsValues>; bad?: string } {
    if (!form || !loaded) return { values: {} };
    const out: Partial<SettingsValues> = {};

    if (form.store_address !== loaded.store_address)
      out.store_address = form.store_address;
    if (form.store_hours !== loaded.store_hours)
      out.store_hours = form.store_hours;
    if (form.store_phone !== loaded.store_phone)
      out.store_phone = form.store_phone;
    if (form.store_email !== loaded.store_email)
      out.store_email = form.store_email;
    if (form.admin_notification_email !== loaded.admin_notification_email)
      out.admin_notification_email = form.admin_notification_email;

    const daysStr = form.default_pickup_deadline_days.trim();
    if (daysStr !== String(loaded.default_pickup_deadline_days)) {
      const days = Number(daysStr);
      if (!Number.isInteger(days)) return { values: {}, bad: "default_pickup_deadline_days" };
      out.default_pickup_deadline_days = days;
    }
    return { values: out };
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setActionError(null);
    setFieldErrors({});
    setSavedAt(null);

    const { values, bad } = diff();
    if (bad) {
      setFieldErrors({ [bad]: "Въведете цяло число." });
      return;
    }
    if (Object.keys(values).length === 0) {
      setActionError("Няма промени за запазване.");
      return;
    }

    setSaving(true);
    const res = await updateAdminSettings({ expectedVersion: version, values });
    setSaving(false);

    if (res.ok) {
      setForm(toForm(res.value.values));
      setLoaded(res.value.values);
      setVersion(res.value.version);
      setSavedAt(Date.now());
      return;
    }

    if (res.error.kind === "not_admin") {
      router.refresh();
      return;
    }
    if (res.error.kind === "version_conflict") {
      const fresh = await fetchAdminSettings();
      if (fresh.ok) {
        setForm(toForm(fresh.value.values));
        setLoaded(fresh.value.values);
        setVersion(fresh.value.version);
      }
      setActionError(errorMessage(res.error));
      return;
    }
    if (res.error.kind === "validation") {
      const next: Record<string, string> = {};
      for (const f of res.error.fields) {
        next[f.path.replace(/^values\./, "")] = f.message;
      }
      setFieldErrors(next);
      setActionError(res.error.fields.length === 0 ? errorMessage(res.error) : null);
      return;
    }
    setActionError(errorMessage(res.error));
  }

  if (loadError) {
    return (
      <div className="max-w-2xl">
        <h1 className="text-2xl font-bold mb-6">Настройки на магазина</h1>
        <p role="alert" className="text-sm text-red-700">
          {loadError}
        </p>
      </div>
    );
  }

  if (!form) {
    return (
      <div className="max-w-2xl space-y-4">
        <h1 className="text-2xl font-bold mb-6">Настройки на магазина</h1>
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold mb-2">Настройки на магазина</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Промяната засяга само бъдещи действия — вече направените поръчки и
        поставените срокове не се променят.
      </p>

      <form onSubmit={onSubmit} className="space-y-6" noValidate>
        <section className="rounded-lg border border-border bg-white p-5 space-y-4">
          <h2 className="font-semibold">Контактна информация</h2>

          <Field
            id="store_address"
            label="Адрес на магазина"
            error={fieldErrors.store_address}
          >
            <Textarea
              id="store_address"
              value={form.store_address}
              onChange={(e) => set("store_address", e.target.value)}
              rows={2}
              autoComplete="street-address"
              aria-invalid={Boolean(fieldErrors.store_address)}
              aria-describedby={
                fieldErrors.store_address ? "store_address-error" : undefined
              }
            />
          </Field>

          <Field
            id="store_phone"
            label="Телефон за контакт"
            error={fieldErrors.store_phone}
          >
            <Input
              id="store_phone"
              type="tel"
              value={form.store_phone}
              onChange={(e) => set("store_phone", e.target.value)}
              className="max-w-sm"
              autoComplete="tel"
              aria-invalid={Boolean(fieldErrors.store_phone)}
              aria-describedby={
                fieldErrors.store_phone ? "store_phone-error" : undefined
              }
            />
          </Field>

          <Field
            id="store_email"
            label="Имейл за контакт"
            error={fieldErrors.store_email}
          >
            <Input
              id="store_email"
              type="email"
              value={form.store_email}
              onChange={(e) => set("store_email", e.target.value)}
              className="max-w-sm"
              autoComplete="email"
              aria-invalid={Boolean(fieldErrors.store_email)}
              aria-describedby={
                fieldErrors.store_email ? "store_email-error" : undefined
              }
            />
          </Field>
        </section>

        <section className="rounded-lg border border-border bg-white p-5 space-y-4">
          <h2 className="font-semibold">Работно време</h2>
          <Field
            id="store_hours"
            label="Дни и часове на работа"
            error={fieldErrors.store_hours}
            hint="Напр. „Пон-Пет: 9:00-18:00, Сб: 10:00-14:00, Нд: почивен ден“."
          >
            <Textarea
              id="store_hours"
              value={form.store_hours}
              onChange={(e) => set("store_hours", e.target.value)}
              rows={2}
              aria-invalid={Boolean(fieldErrors.store_hours)}
              aria-describedby={
                fieldErrors.store_hours ? "store_hours-error" : "store_hours-hint"
              }
            />
          </Field>
        </section>

        <section className="rounded-lg border border-border bg-white p-5 space-y-4">
          <h2 className="font-semibold">Операции</h2>

          <Field
            id="default_pickup_deadline_days"
            label="Краен срок за вземане (дни)"
            error={fieldErrors.default_pickup_deadline_days}
            hint="Предварително попълва полето при маркиране „Готова за вземане“ (1–60)."
          >
            <Input
              id="default_pickup_deadline_days"
              type="number"
              min={1}
              max={60}
              inputMode="numeric"
              value={form.default_pickup_deadline_days}
              onChange={(e) => set("default_pickup_deadline_days", e.target.value)}
              className="max-w-[8rem]"
              aria-invalid={Boolean(fieldErrors.default_pickup_deadline_days)}
              aria-describedby={
                fieldErrors.default_pickup_deadline_days
                  ? "default_pickup_deadline_days-error"
                  : "default_pickup_deadline_days-hint"
              }
            />
          </Field>

          <Field
            id="admin_notification_email"
            label="Имейл за известия към администратора"
            error={fieldErrors.admin_notification_email}
            hint="Нови поръчки, анулирания, изтекли срокове. Празно = по подразбиране."
          >
            <Input
              id="admin_notification_email"
              type="email"
              value={form.admin_notification_email}
              onChange={(e) => set("admin_notification_email", e.target.value)}
              className="max-w-sm"
              autoComplete="email"
              aria-invalid={Boolean(fieldErrors.admin_notification_email)}
              aria-describedby={
                fieldErrors.admin_notification_email
                  ? "admin_notification_email-error"
                  : "admin_notification_email-hint"
              }
            />
          </Field>
        </section>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={saving}>
            {saving ? "Запазване…" : "Запази настройките"}
          </Button>
          {savedAt && (
            <p role="status" className="text-sm text-green-700">
              Настройките са записани!
            </p>
          )}
          {actionError && (
            <p role="alert" className="text-sm text-red-700">
              {actionError}
            </p>
          )}
        </div>
      </form>
    </div>
  );
}

// ─── Field wrapper ─────────────────────────────────────────────────────────────

function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <div className="mt-1">{children}</div>
      {hint && !error && (
        <p id={`${id}-hint`} className="mt-1 text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="mt-1 text-xs text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
