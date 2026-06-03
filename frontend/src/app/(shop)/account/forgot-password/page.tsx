"use client";

import { useState } from "react";
import Link from "next/link";
import { Mail, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ButtonLink } from "@/components/ui/button-link";
import { forgotPassword } from "@/lib/auth/client";

/**
 * /account/forgot-password
 *
 * Single email input. POSTs to /auth/forgot-password and ALWAYS shows the
 * same "if the email exists, you'll receive a link" success copy — the
 * backend returns the same shape regardless of whether the address is
 * registered, and the UI has to do likewise. Otherwise an attacker could
 * tell registered addresses apart by reading the page output.
 *
 * The only branch that does NOT show the success copy:
 *   - kind === "validation": malformed email. Render inline against the
 *     input. The user re-submits.
 *   - kind === "network": fetch failed before the API saw the request.
 *     Recoverable; show the retry copy.
 *
 * No client-side rate limit. The backend caps at 3/hour, 5/day per email
 * AND treats over-cap requests as silent no-ops — both inside the same
 * generic 200. So a determined click-spammer just gets a few more 200s
 * with no email arriving on their side, which is the best we can do
 * without a CAPTCHA (a future tightening).
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await forgotPassword(email.trim());
      if (!res.ok) {
        switch (res.error.kind) {
          case "validation":
            setError(
              res.error.fields[0]?.message ??
                "Моля въведете валиден имейл адрес.",
            );
            return;
          case "network":
            setError(
              "Не може да се свърже със сървъра. Проверете интернет връзката и опитайте отново.",
            );
            return;
          default:
            // Unknown errors: still show the same success copy. We refuse
            // to leak any internal failure beyond network/validation — the
            // worst case is the user retries a few minutes later.
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
          href="/account/login"
          className="gap-1.5 mb-6 -ml-2"
        >
          <ArrowLeft className="w-4 h-4" /> Обратно към вход
        </ButtonLink>

        <div className="mb-6">
          <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
            <Mail className="w-6 h-6 text-primary-strong" />
          </div>
          <h1 className="text-2xl font-bold">Забравена парола</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Въведете имейла си и ще ви изпратим линк за нулиране на паролата.
          </p>
        </div>

        {sent ? (
          <div
            className="rounded-lg border border-green-200 bg-green-50 p-5 text-center space-y-2"
            role="status"
            aria-live="polite"
          >
            <p className="font-semibold text-green-700">
              Проверете пощата си
            </p>
            <p className="text-sm text-green-700">
              Ако този имейл е свързан с акаунт, ще получите линк за
              нулиране на паролата в рамките на няколко минути.
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              Не намирате имейла? Проверете папката &quot;Спам&quot;. Линкът е валиден 1 час.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <div>
              <Label htmlFor="email">Email адрес</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
                className="mt-1"
                placeholder="you@example.com"
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

            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? "Изпращане..." : "Изпрати линк за нулиране"}
            </Button>
          </form>
        )}

        <p className="text-center text-sm text-muted-foreground mt-6">
          Спомнихте си паролата?{" "}
          <Link
            href="/account/login"
            className="text-primary-strong underline"
          >
            Влезте тук
          </Link>
        </p>
      </div>
    </div>
  );
}
