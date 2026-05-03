"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

export default function LoginPage() {
  const router = useRouter();
  const params = useSearchParams();
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // After login we either honour an explicit ?next=/somewhere from the
  // proxy/middleware redirect, or fall back to a sensible default. We don't
  // honour absolute URLs in `next` to prevent open-redirect attacks.
  const nextParam = params.get("next");
  const safeNext =
    nextParam && nextParam.startsWith("/") && !nextParam.startsWith("//")
      ? nextParam
      : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await login({ email, password, rememberMe });
      if (!res.ok) {
        switch (res.error.kind) {
          case "invalid_credentials":
            setError("Невалиден имейл или парола.");
            break;
          case "account_locked":
            setError(
              res.error.unlockAt
                ? `Акаунтът е временно заключен поради твърде много опити. Опитайте отново след ${formatUnlockAt(res.error.unlockAt)}.`
                : "Акаунтът е временно заключен поради твърде много опити. Опитайте отново по-късно.",
            );
            break;
          case "validation":
            setError(
              res.error.fields[0]?.message ??
                "Моля, проверете въведените данни.",
            );
            break;
          case "network":
            setError("Не може да се свърже със сървъра. Проверете интернет връзката.");
            break;
          default:
            setError("Възникна неочаквана грешка. Опитайте отново.");
        }
        return;
      }

      // Success. Route based on role first, then optional ?next override.
      const target = safeNext ?? (res.value.role === "admin" ? "/admin" : "/account/profile");
      router.push(target);
      router.refresh(); // re-fetch server components so SSR auth state updates
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="max-w-sm mx-auto px-4 py-12">
      <div className="text-center mb-8">
        <h1 className="text-2xl font-bold">Вход</h1>
        <p className="text-muted-foreground text-sm mt-1">Влезте в своя акаунт</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div>
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
            autoFocus
            className="mt-1"
            placeholder="you@example.com"
            disabled={pending}
          />
        </div>
        <div>
          <div className="flex justify-between items-center">
            <Label htmlFor="password">Парола</Label>
            <Link href="/account/forgot-password" className="text-xs text-primary hover:underline">
              Забравена парола?
            </Link>
          </div>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            className="mt-1"
            disabled={pending}
          />
        </div>

        <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
          <input
            type="checkbox"
            checked={rememberMe}
            onChange={(e) => setRememberMe(e.target.checked)}
            disabled={pending}
            className="h-4 w-4 rounded border-input"
          />
          <span>Запомни ме</span>
        </label>

        {error && (
          <p
            role="alert"
            aria-live="polite"
            className="text-sm text-destructive bg-destructive/5 border border-destructive/20 rounded-md p-2"
          >
            {error}
          </p>
        )}

        <Button type="submit" className="w-full" size="lg" disabled={pending}>
          {pending ? "Изчакайте..." : "Вход"}
        </Button>
      </form>

      <Separator className="my-6" />

      <div className="text-center space-y-2 text-sm">
        <p className="text-muted-foreground">Нямате акаунт?</p>
        <ButtonLink variant="outline" className="w-full" href="/account/register">Регистрация</ButtonLink>
      </div>

      <div className="mt-4 text-center">
        <Link href="/checkout" className="text-sm text-primary hover:underline">
          Продължи като гост →
        </Link>
      </div>
    </div>
  );
}

/**
 * Format a server-supplied unlock timestamp (ISO 8601) into a human-readable
 * "in N minutes" hint. Used for the 429 account-locked error so the user
 * knows when to retry.
 */
function formatUnlockAt(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "няколко минути";
  const minutes = Math.max(1, Math.ceil((at.getTime() - Date.now()) / 60000));
  return `${minutes} ${minutes === 1 ? "минута" : "минути"}`;
}
