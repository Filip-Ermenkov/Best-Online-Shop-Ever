"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Download, ShieldCheck, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/AuthContext";
import { requestDataExport } from "@/lib/auth/client";

/**
 * /account/data-export
 *
 * GDPR Art. 15 (right of access) + Art. 20 (right to data portability),
 * self-service. Completes the data-rights triad the shop already offers:
 * Art. 16 rectify (/account/profile), Art. 17 erase (/account/delete), and
 * Art. 15/20 export (here).
 *
 * UX posture:
 *
 *   1. Current-password re-auth. The export is a one-shot copy of everything
 *      we hold about the user, so a stolen cookie alone must not pull it —
 *      consistent with /account/delete and /account/profile's password
 *      change. Identical re-auth field, same threat model.
 *
 *   2. Plain explanation of what is included and what is deliberately NOT
 *      (credentials and secrets), so the access right stays transparent.
 *
 *   3. On success the API streams a JSON document as a download. We turn the
 *      returned Blob into an object URL and click a synthetic <a download> —
 *      the (potentially large, PII-heavy) payload never lives in React state
 *      or the URL bar.
 *
 *   4. Non-destructive: no scary confirmation phrase (nothing is changed or
 *      deleted). The re-auth is the only gate. A per-user frequency cap on
 *      the backend (5/hour) surfaces here as `export_rate_limited`.
 */

export default function DataExportPage() {
  const router = useRouter();
  const { user, status } = useAuth();

  const [currentPassword, setCurrentPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadedName, setDownloadedName] = useState<string | null>(null);

  // Client-side gate. The proxy cookie-presence check is the real protection;
  // this handles a session that expired in another tab after navigation.
  useEffect(() => {
    if (status === "anonymous") {
      router.replace("/account/login?next=/account/data-export");
    }
  }, [status, router]);

  if (status !== "authenticated" || !user) {
    return (
      <div className="max-w-md mx-auto px-4 py-12 text-center text-sm text-muted-foreground">
        Зареждане...
      </div>
    );
  }

  const canSubmit = currentPassword.length > 0 && !pending;

  function triggerDownload(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke on the next tick so the click has definitely started the save.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDownloadedName(null);

    if (!currentPassword) {
      setError("Моля въведете текущата си парола.");
      return;
    }

    setPending(true);
    try {
      const res = await requestDataExport(currentPassword);
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
          case "export_rate_limited":
            setError(
              "Заявихте експорт няколко пъти наскоро. Моля опитайте отново малко по-късно.",
            );
            return;
          case "validation":
            setError(
              res.error.fields[0]?.message ??
                "Моля проверете въведените данни.",
            );
            return;
          case "unauthenticated":
            router.replace("/account/login?next=/account/data-export");
            return;
          case "network":
            setError(
              "Не може да се свърже със сървъра. Проверете интернет връзката и опитайте отново.",
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
      triggerDownload(res.value.blob, res.value.filename);
      setDownloadedName(res.value.filename);
      // Clear the password field — no reason to keep it in memory after use.
      setCurrentPassword("");
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
          <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center mb-4">
            <Download className="w-6 h-6 text-blue-600" />
          </div>
          <h1 className="text-2xl font-bold">Експорт на личните Ви данни</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Акаунт:{" "}
            <span className="font-medium text-foreground">{user.email}</span>
          </p>
        </div>

        {/* What this is */}
        <section className="mb-6">
          <p className="text-sm text-muted-foreground leading-relaxed">
            Изтеглете копие на личните данни, които съхраняваме за Вас, в
            структуриран, машинно четим формат (JSON). Това право Ви е
            гарантирано от правото на достъп (чл. 15) и правото на преносимост
            на данните (чл. 20) от Общия регламент относно защитата на данните.
          </p>
        </section>

        {/* What's included */}
        <section className="mb-6">
          <h2 className="text-sm font-semibold mb-2">Какво е включено:</h2>
          <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-1">
            <li>Данни за акаунта и профила Ви</li>
            <li>Адресите от адресния Ви бележник</li>
            <li>Текущото съдържание на кошницата Ви</li>
            <li>
              Пълната история на поръчките Ви (артикули, доставка, статуси,
              откази)
            </li>
            <li>
              Информация за обработването: цели, категории, срокове на
              съхранение и правата Ви
            </li>
          </ul>
        </section>

        {/* What's excluded */}
        <section className="mb-6 rounded-md border border-zinc-200 bg-zinc-50 p-4">
          <h2 className="text-sm font-semibold mb-2 flex items-center gap-1.5">
            <ShieldCheck className="w-4 h-4 text-zinc-500" />
            Какво НЕ е включено (от съображения за сигурност):
          </h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Пароли, токени за сесии и кодове за възстановяване не се включват —
            те се съхраняват само като необратими хешове и разкриването им би
            било риск за сигурността. Подробните записи на опитите за вход не се
            изнасят в суров вид; вместо това е включено обобщение.
          </p>
        </section>

        {/* Success state */}
        {downloadedName && (
          <div
            role="status"
            aria-live="polite"
            className="mb-6 rounded-md border border-green-200 bg-green-50 p-4 flex items-start gap-2"
          >
            <CheckCircle2 className="w-5 h-5 text-green-700 shrink-0 mt-0.5" />
            <div className="text-sm text-green-800">
              <p className="font-semibold">Експортът е готов.</p>
              <p className="mt-0.5">
                Файлът{" "}
                <span className="font-mono break-all">{downloadedName}</span> се
                изтегли. Изпратихме и известие на имейла Ви, че е извършен
                експорт на данните.
              </p>
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
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
              Изискваме паролата Ви като защита срещу неоторизиран достъп до
              данните Ви.
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
            <Button type="submit" disabled={!canSubmit} className="flex-1 gap-1.5">
              <Download className="w-4 h-4" />
              {pending ? "Подготовка..." : "Изтегли данните си"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
