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

export default function ProfilePage() {
  const { user, status, logout } = useAuth();
  const router = useRouter();
  const [saved, setSaved] = useState(false);

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

  // Profile editing isn't wired to a backend endpoint yet — there's no
  // PATCH /auth/me. Until that ships, the form is client-side-only and
  // shows a toast on save without persisting. Marked as such so it's
  // obvious to the next slice owner what's missing.
  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
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

      <form onSubmit={handleSave} className="space-y-4">
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
            За промяна на имейл адреса се свържете с поддръжката.
          </p>
        </div>
        <div>
          <Label htmlFor="phone">Телефон</Label>
          <Input id="phone" type="tel" className="mt-1" placeholder="+359 88 ..." />
        </div>

        <Separator />

        <h2 className="font-semibold">Смяна на парола</h2>
        <div>
          <Label htmlFor="currentPassword">Текуща парола</Label>
          <Input id="currentPassword" type="password" autoComplete="current-password" className="mt-1" />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="newPassword">Нова парола</Label>
            <Input id="newPassword" type="password" autoComplete="new-password" className="mt-1" />
          </div>
          <div>
            <Label htmlFor="confirmNewPassword">Потвърди</Label>
            <Input id="confirmNewPassword" type="password" autoComplete="new-password" className="mt-1" />
          </div>
        </div>

        <div className="flex items-center gap-3 pt-2">
          <Button type="submit">Запази промените</Button>
          {saved && <p className="text-sm text-green-600">Записано успешно!</p>}
        </div>
        <p className="text-xs text-muted-foreground">
          Промените на профила все още не се записват — този endpoint ще бъде налично в следващата версия.
        </p>
      </form>
    </div>
  );
}
