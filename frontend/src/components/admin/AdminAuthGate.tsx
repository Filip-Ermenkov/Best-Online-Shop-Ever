"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Check, Copy, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  adminLogin,
  adminMfa,
  adminMfaConfirm,
  adminMfaSetup,
} from "@/lib/admin/client";
import { encodeQr } from "@/lib/admin/qr";
import type { AdminAuthError } from "@/lib/admin/types";

/**
 * Inline admin authentication gate.
 *
 * Rendered by app/admin/layout.tsx whenever the visitor is not an authenticated
 * admin (see that file). It runs the whole /admin/auth/* flow in place — no
 * separate /admin/login route, so there is no redirect loop with the gating
 * layout — and on success calls router.refresh() so the SAME server layout
 * re-renders, now resolving an admin session and showing the panel.
 *
 *   login ─▶ (already enrolled) ─▶ mfa ──────────────▶ done
 *         └▶ (first login)      ─▶ enroll ─▶ recovery ▶ done
 *
 * Mirrors the storefront's auth UX (Bulgarian copy, role="alert" live-region
 * errors, focus-visible controls, disabled-while-pending).
 */

type Step = "login" | "mfa" | "enroll" | "recovery";

function errorMessage(error: AdminAuthError): string {
  switch (error.kind) {
    case "invalid_credentials":
      return "Невалиден имейл или парола.";
    case "account_locked":
      return error.unlockAt
        ? `Входът е временно заключен поради твърде много опити. Опитайте отново след ${formatUnlockAt(error.unlockAt)}.`
        : "Входът е временно заключен поради твърде много опити. Опитайте отново по-късно.";
    case "mfa_invalid":
      return "Кодът е невалиден или сесията за вход изтече. Опитайте отново.";
    case "already_enrolled":
      return "Двуфакторната автентикация вече е настроена за този акаунт.";
    case "not_configured":
      return "Административната автентикация не е конфигурирана на сървъра (липсват ADMIN_MFA ключове).";
    case "validation":
      return error.fields[0]?.message ?? "Моля, проверете въведените данни.";
    case "network":
      return "Не може да се свърже със сървъра. Проверете връзката.";
    default:
      return "Възникна неочаквана грешка. Опитайте отново.";
  }
}

export default function AdminAuthGate({
  signedInAsNonAdmin = false,
}: {
  signedInAsNonAdmin?: boolean;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("login");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");

  // Carried between steps.
  const [challenge, setChallenge] = useState("");
  const [secret, setSecret] = useState("");
  const [otpauthUri, setOtpauthUri] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [savedAck, setSavedAck] = useState(false);

  function resetToLogin() {
    setStep("login");
    setError(null);
    setCode("");
    setChallenge("");
    setSecret("");
    setOtpauthUri("");
  }

  /** Re-enter the panel: the server layout re-evaluates the (now admin) session. */
  function enterPanel() {
    router.refresh();
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await adminLogin({ email, password });
      if (!res.ok) {
        setError(errorMessage(res.error));
        return;
      }
      setCode("");
      if (res.value.status === "mfa_required") {
        setChallenge(res.value.challenge);
        setStep("mfa");
        return;
      }
      // enrollment_required → provision a secret immediately.
      const setup = await adminMfaSetup({ challenge: res.value.challenge });
      if (!setup.ok) {
        setError(errorMessage(setup.error));
        return;
      }
      setSecret(setup.value.secret);
      setOtpauthUri(setup.value.otpauthUri);
      setChallenge(setup.value.challenge);
      setStep("enroll");
    } finally {
      setPending(false);
    }
  }

  async function handleMfa(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await adminMfa({ challenge, code: code.trim() });
      if (!res.ok) {
        setError(errorMessage(res.error));
        return;
      }
      enterPanel();
    } finally {
      setPending(false);
    }
  }

  async function handleConfirm(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await adminMfaConfirm({ challenge, code: code.trim() });
      if (!res.ok) {
        setError(errorMessage(res.error));
        return;
      }
      setRecoveryCodes(res.value.recoveryCodes);
      setStep("recovery");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <ShieldCheck className="w-8 h-8 mx-auto text-primary-strong" aria-hidden="true" />
          <h1 className="text-2xl font-bold mt-2">Администрация</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {step === "login" && "Вход за администратор"}
            {step === "mfa" && "Въведете кода от приложението"}
            {step === "enroll" && "Настройка на двуфакторна автентикация"}
            {step === "recovery" && "Запазете кодовете за възстановяване"}
          </p>
        </div>

        {signedInAsNonAdmin && step === "login" && (
          <div
            role="status"
            className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"
          >
            Влезли сте като клиент. Влезте с администраторски акаунт, за да
            продължите.
          </div>
        )}

        {error && (
          <p
            role="alert"
            aria-live="assertive"
            className="mb-4 text-sm text-destructive bg-destructive/5 border border-destructive/20 rounded-md p-2"
          >
            {error}
          </p>
        )}

        {/* ── Step 1: password ─────────────────────────────────────────── */}
        {step === "login" && (
          <form onSubmit={handleLogin} className="space-y-4" noValidate>
            <div>
              <Label htmlFor="admin-email">Email</Label>
              <Input
                id="admin-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                required
                className="mt-1"
                placeholder="admin@shop.bg"
                disabled={pending}
              />
            </div>
            <div>
              <Label htmlFor="admin-password">Парола</Label>
              <Input
                id="admin-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                className="mt-1"
                disabled={pending}
              />
            </div>
            <Button type="submit" className="w-full" size="lg" disabled={pending}>
              {pending ? "Изчакайте..." : "Вход"}
            </Button>
          </form>
        )}

        {/* ── Step 2a: verify TOTP / recovery code ─────────────────────── */}
        {step === "mfa" && (
          <form onSubmit={handleMfa} className="space-y-4" noValidate>
            <div>
              <Label htmlFor="admin-code">Код за потвърждение</Label>
              <Input
                id="admin-code"
                type="text"
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="one-time-code"
                required
                className="mt-1 tracking-widest text-center text-lg"
                placeholder="123456"
                disabled={pending}
                aria-describedby="admin-code-help"
              />
              <p id="admin-code-help" className="text-xs text-muted-foreground mt-1">
                6-цифрен код от приложението, или код за възстановяване.
              </p>
            </div>
            <Button type="submit" className="w-full" size="lg" disabled={pending}>
              {pending ? "Проверка..." : "Потвърди"}
            </Button>
            <button
              type="button"
              onClick={resetToLogin}
              className="block w-full text-center text-xs text-muted-foreground underline"
            >
              ← Започни отначало
            </button>
          </form>
        )}

        {/* ── Step 2b: first-login enrolment ───────────────────────────── */}
        {step === "enroll" && (
          <form onSubmit={handleConfirm} className="space-y-4" noValidate>
            <p className="text-sm text-muted-foreground">
              Сканирайте кода с приложение за автентикация (Google Authenticator,
              Aegis, 1Password…), след което въведете генерирания 6-цифрен код.
            </p>

            <div className="flex justify-center">
              <QrCode value={otpauthUri} />
            </div>

            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground underline">
                Не можете да сканирате? Въведете ключа ръчно
              </summary>
              <div className="mt-2 space-y-2">
                <CopyField value={formatSecret(secret)} copyValue={secret} mono />
                <CopyField value={otpauthUri} copyValue={otpauthUri} mono small />
              </div>
            </details>

            <div>
              <Label htmlFor="enroll-code">Код от приложението</Label>
              <Input
                id="enroll-code"
                type="text"
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="one-time-code"
                required
                pattern="\d{6}"
                maxLength={6}
                className="mt-1 tracking-widest text-center text-lg"
                placeholder="123456"
                disabled={pending}
              />
            </div>
            <Button type="submit" className="w-full" size="lg" disabled={pending}>
              {pending ? "Активиране..." : "Активирай и влез"}
            </Button>
            <button
              type="button"
              onClick={resetToLogin}
              className="block w-full text-center text-xs text-muted-foreground underline"
            >
              ← Започни отначало
            </button>
          </form>
        )}

        {/* ── Step 3: recovery codes (shown once) ──────────────────────── */}
        {step === "recovery" && (
          <div className="space-y-4">
            <div
              role="status"
              className="rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-700"
            >
              Двуфакторната автентикация е активирана. Запазете кодовете за
              възстановяване — те се показват само сега.
            </div>
            <ul className="grid grid-cols-2 gap-2 font-mono text-sm bg-muted/50 border rounded-md p-3">
              {recoveryCodes.map((c) => (
                <li key={c} className="text-center">
                  {c}
                </li>
              ))}
            </ul>
            <CopyField
              value="Копирай всички кодове"
              copyValue={recoveryCodes.join("\n")}
              asButton
            />
            <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
              <input
                type="checkbox"
                checked={savedAck}
                onChange={(e) => setSavedAck(e.target.checked)}
                aria-label="Запазих кодовете на сигурно място"
                className="h-4 w-4 rounded border-input"
              />
              <span>Запазих кодовете на сигурно място.</span>
            </label>
            <Button
              type="button"
              className="w-full"
              size="lg"
              disabled={!savedAck}
              onClick={enterPanel}
            >
              Влез в администрацията
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The otpauth URI rendered as a scannable QR, as an inline SVG — no canvas and
 * no `data:` URI, so it needs no CSP relaxation (the strict policy already
 * allows `'self'` inline SVG DOM). The encoder is the first-party, segno-
 * verified one in lib/admin/qr.ts. A 4-module quiet zone is included (scanners
 * require it).
 */
function QrCode({ value, pixels = 208 }: { value: string; pixels?: number }) {
  const qr = useMemo(() => {
    try {
      return encodeQr(value);
    } catch {
      return null;
    }
  }, [value]);
  if (!qr) return null;
  const quiet = 4;
  const dim = qr.size + quiet * 2;
  let path = "";
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (qr.modules[r]![c]) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
    }
  }
  return (
    <svg
      viewBox={`0 0 ${dim} ${dim}`}
      width={pixels}
      height={pixels}
      role="img"
      aria-label="QR код за настройка на двуфакторна автентикация"
      shapeRendering="crispEdges"
      className="rounded-md border bg-white p-2"
    >
      <rect width={dim} height={dim} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}

/** A read-only value with a copy-to-clipboard button. */
function CopyField({
  value,
  copyValue,
  mono = false,
  small = false,
  asButton = false,
}: {
  value: string;
  copyValue: string;
  mono?: boolean;
  small?: boolean;
  asButton?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(copyValue);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the value is visible for manual copy */
    }
  }
  if (asButton) {
    return (
      <Button type="button" variant="outline" className="w-full" onClick={copy}>
        {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
        {copied ? "Копирано" : value}
      </Button>
    );
  }
  return (
    <div className="mt-1 flex items-stretch gap-2">
      <code
        className={`flex-1 min-w-0 break-all rounded-md border bg-muted/50 px-2 py-1.5 ${
          mono ? "font-mono" : ""
        } ${small ? "text-[11px]" : "text-sm"}`}
      >
        {value}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label="Копирай"
        className="shrink-0 rounded-md border px-2 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-strong"
      >
        {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
      </button>
    </div>
  );
}

/** Group a Base32 secret into 4-char blocks for legibility. */
function formatSecret(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

/** "in N minutes" hint from an ISO unlock timestamp. */
function formatUnlockAt(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "няколко минути";
  const minutes = Math.max(1, Math.ceil((at.getTime() - Date.now()) / 60000));
  return `${minutes} ${minutes === 1 ? "минута" : "минути"}`;
}
