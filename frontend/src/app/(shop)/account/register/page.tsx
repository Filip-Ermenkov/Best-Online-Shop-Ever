"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

type AccountType = "personal" | "corporate";

interface FormState {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  password: string;
  confirmPassword: string;
  companyName: string;
  vatNumber: string;
}

const EMPTY: FormState = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  password: "",
  confirmPassword: "",
  companyName: "",
  vatNumber: "",
};

export default function RegisterPage() {
  const router = useRouter();
  const { register } = useAuth();
  const [accountType, setAccountType] = useState<AccountType>("personal");
  const [form, setForm] = useState<FormState>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  function setField<K extends keyof FormState>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Corporate registration isn't wired in the backend yet (no
    // /auth/register-corporate endpoint, no corporate_profiles writer).
    // The UI shows the toggle so the design surface stays consistent with
    // the spec, but submission is gated for personal-only until that slice.
    if (accountType === "corporate") {
      setError("Регистрацията на фирмени акаунти ще бъде налична скоро. За момента моля изберете 'Физическо лице'.");
      return;
    }

    // Cheap local validation to avoid round-tripping the obvious cases.
    // The backend re-validates everything — Zod is the source of truth —
    // but a snappier first error pass improves UX.
    if (form.password !== form.confirmPassword) {
      setError("Паролите не съвпадат.");
      return;
    }

    setPending(true);
    try {
      const fullName = `${form.firstName.trim()} ${form.lastName.trim()}`.trim();
      const res = await register({
        email: form.email,
        password: form.password,
        fullName,
        phone: form.phone,
      });

      if (!res.ok) {
        switch (res.error.kind) {
          case "breached_password":
            setError(
              "Тази парола е била включена в известен пробив в данни и не може да бъде използвана. Моля, изберете различна, по-добре дълга фраза.",
            );
            break;
          case "validation": {
            // Map Zod field paths to Bulgarian copy.
            const first = res.error.fields[0];
            if (first?.path === "password") {
              // The server enforces three things on this field:
              //   1. ≥12 characters (length-only, no composition rules)
              //   2. ≤1024 characters (cost cap)
              //   3. Not in the HIBP Pwned Passwords corpus
              // (1) and (2) come back with the schema's English text; (3)
              // comes back with the "data breach" message from the route
              // handler. Surface the message the server actually sent so the
              // user sees the specific reason — falling back to a generic
              // length hint only when no server message is available.
              setError(
                first.message ||
                  "Паролата трябва да е поне 12 символа.",
              );
            } else if (first?.path === "email") {
              setError("Моля, въведете валиден имейл адрес.");
            } else if (first?.path === "phone") {
              setError("Моля, въведете валиден телефонен номер.");
            } else if (first?.path === "fullName") {
              setError("Моля, въведете име.");
            } else {
              setError(first?.message ?? "Моля, проверете въведените данни.");
            }
            break;
          }
          case "network":
            setError("Не може да се свърже със сървъра. Проверете интернет връзката.");
            break;
          default:
            setError("Възникна неочаквана грешка. Опитайте отново.");
        }
        return;
      }

      // Success. The backend deliberately returns the same { ok: true } shape
      // for both new accounts and "this email already exists" — to prevent
      // account enumeration. So we ALWAYS show "check your inbox" after a
      // successful POST. When SES + verification land, the duplicate branch
      // will trigger an actual "you already have an account" email.
      setDone(true);
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <div className="max-w-sm mx-auto px-4 py-12 text-center">
        <h1 className="text-2xl font-bold mb-4">Благодарим Ви!</h1>
        <p className="text-muted-foreground mb-6">
          Изпратихме съобщение на <strong>{form.email}</strong> с инструкции за
          активиране на акаунта. Проверете и папката за спам.
        </p>
        <Button onClick={() => router.push("/account/login")} className="w-full">
          Към страницата за вход
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-sm mx-auto px-4 py-12">
      <div className="text-center mb-8">
        <h1 className="text-2xl font-bold">Регистрация</h1>
        <p className="text-muted-foreground text-sm mt-1">Създайте безплатен акаунт</p>
      </div>

      <div className="flex rounded-lg border border-border overflow-hidden mb-6">
        {(["personal", "corporate"] as const).map((type) => (
          <button
            key={type}
            type="button"
            onClick={() => setAccountType(type)}
            className={cn(
              "flex-1 py-2 text-sm font-medium transition-colors",
              accountType === type ? "bg-primary text-primary-foreground" : "hover:bg-muted",
            )}
          >
            {type === "personal" ? "Физическо лице" : "Фирма"}
          </button>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="space-y-3" noValidate>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="firstName">Име</Label>
            <Input
              id="firstName"
              value={form.firstName}
              onChange={(e) => setField("firstName", e.target.value)}
              autoComplete="given-name"
              required
              className="mt-1"
              disabled={pending}
            />
          </div>
          <div>
            <Label htmlFor="lastName">Фамилия</Label>
            <Input
              id="lastName"
              value={form.lastName}
              onChange={(e) => setField("lastName", e.target.value)}
              autoComplete="family-name"
              required
              className="mt-1"
              disabled={pending}
            />
          </div>
        </div>
        <div>
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            value={form.email}
            onChange={(e) => setField("email", e.target.value)}
            autoComplete="email"
            required
            className="mt-1"
            disabled={pending}
          />
        </div>
        <div>
          <Label htmlFor="phone">Телефон</Label>
          <Input
            id="phone"
            type="tel"
            value={form.phone}
            onChange={(e) => setField("phone", e.target.value)}
            autoComplete="tel"
            required
            className="mt-1"
            placeholder="+359 88 ..."
            disabled={pending}
          />
        </div>

        {accountType === "corporate" && (
          <>
            <div>
              <Label htmlFor="companyName">Фирма</Label>
              <Input
                id="companyName"
                value={form.companyName}
                onChange={(e) => setField("companyName", e.target.value)}
                required
                className="mt-1"
                disabled={pending}
              />
            </div>
            <div>
              <Label htmlFor="vatNumber">ДДС номер</Label>
              <Input
                id="vatNumber"
                value={form.vatNumber}
                onChange={(e) => setField("vatNumber", e.target.value)}
                className="mt-1"
                placeholder="BG..."
                disabled={pending}
              />
            </div>
          </>
        )}

        <div>
          <Label htmlFor="password">Парола</Label>
          <Input
            id="password"
            type="password"
            value={form.password}
            onChange={(e) => setField("password", e.target.value)}
            autoComplete="new-password"
            required
            minLength={12}
            className="mt-1"
            disabled={pending}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Поне 12 символа. Дълга фраза с няколко думи е по-сигурна от къса парола със знаци.
          </p>
        </div>
        <div>
          <Label htmlFor="confirmPassword">Потвърди паролата</Label>
          <Input
            id="confirmPassword"
            type="password"
            value={form.confirmPassword}
            onChange={(e) => setField("confirmPassword", e.target.value)}
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

        <p className="text-xs text-muted-foreground">
          С регистрацията приемате нашите{" "}
          <Link href="/terms" className="text-primary-strong underline">Условия за ползване</Link>{" "}
          и{" "}
          <Link href="/privacy" className="text-primary-strong underline">Политика за поверителност</Link>.
        </p>

        <Button type="submit" className="w-full" size="lg" disabled={pending}>
          {pending ? "Изчакайте..." : "Регистрирай се"}
        </Button>
      </form>

      <Separator className="my-6" />
      <p className="text-center text-sm text-muted-foreground">
        Вече имате акаунт?{" "}
        <Link href="/account/login" className="text-primary-strong underline font-medium">Вход</Link>
      </p>
    </div>
  );
}
