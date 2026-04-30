"use client";

import { useAuth } from "@/contexts/AuthContext";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Package } from "lucide-react";

export default function ProfilePage() {
  const { user, isLoggedIn } = useAuth();
  const router = useRouter();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!isLoggedIn) router.push("/account/login");
  }, [isLoggedIn, router]);

  if (!user) return null;

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-10">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Моят профил</h1>
        <ButtonLink variant="outline" size="sm" className="gap-2" href="/account/orders">
          <Package className="w-4 h-4" /> Поръчки
        </ButtonLink>
      </div>

      <div className="rounded-lg border border-border p-5 mb-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-lg">
            {user.firstName[0]}
          </div>
          <div>
            <p className="font-semibold">{user.firstName} {user.lastName}</p>
            <p className="text-sm text-muted-foreground">{user.email}</p>
          </div>
          <div className="ml-auto flex gap-2">
            <Badge variant="outline">{user.accountType === "corporate" ? "Фирма" : "Физическо лице"}</Badge>
            {user.discountPercent > 0 && (
              <Badge className="bg-green-100 text-green-700 border-green-200">
                {user.discountPercent}% отстъпка
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
            <Input id="firstName" defaultValue={user.firstName} className="mt-1" />
          </div>
          <div>
            <Label htmlFor="lastName">Фамилия</Label>
            <Input id="lastName" defaultValue={user.lastName} className="mt-1" />
          </div>
        </div>
        <div>
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" defaultValue={user.email} className="mt-1" />
        </div>
        <div>
          <Label htmlFor="phone">Телефон</Label>
          <Input id="phone" type="tel" className="mt-1" placeholder="+359 88 ..." />
        </div>

        <Separator />

        <h2 className="font-semibold">Смяна на парола</h2>
        <div>
          <Label htmlFor="currentPassword">Текуща парола</Label>
          <Input id="currentPassword" type="password" className="mt-1" />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="newPassword">Нова парола</Label>
            <Input id="newPassword" type="password" className="mt-1" />
          </div>
          <div>
            <Label htmlFor="confirmNewPassword">Потвърди</Label>
            <Input id="confirmNewPassword" type="password" className="mt-1" />
          </div>
        </div>

        <div className="flex items-center gap-3 pt-2">
          <Button type="submit">Запази промените</Button>
          {saved && <p className="text-sm text-green-600">Записано успешно!</p>}
        </div>
      </form>
    </div>
  );
}
