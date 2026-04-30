"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

export default function AdminSettingsPage() {
  const [saved, setSaved] = useState(false);

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold mb-6">Настройки на магазина</h1>

      <form onSubmit={handleSave} className="space-y-6">
        <section className="rounded-lg border border-border bg-white p-5 space-y-4">
          <h2 className="font-semibold">Основни данни</h2>
          <div>
            <Label htmlFor="shopName">Название на магазина</Label>
            <Input id="shopName" defaultValue="Duda 1" className="mt-1 max-w-sm" />
          </div>
          <div>
            <Label htmlFor="shopEmail">Email за контакт</Label>
            <Input id="shopEmail" type="email" defaultValue="contact@duda1.bg" className="mt-1 max-w-sm" />
          </div>
          <div>
            <Label htmlFor="shopPhone">Телефон</Label>
            <Input id="shopPhone" type="tel" defaultValue="+359 2 123 4567" className="mt-1 max-w-sm" />
          </div>
          <div>
            <Label htmlFor="shopAddress">Адрес за вземане на пратки</Label>
            <Input id="shopAddress" defaultValue="ул. Витоша 1, София 1000" className="mt-1" />
          </div>
        </section>

        <Separator />

        <section className="rounded-lg border border-border bg-white p-5 space-y-4">
          <h2 className="font-semibold">Работно време</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="openTime">Отваряне</Label>
              <Input id="openTime" type="time" defaultValue="09:00" className="mt-1" />
            </div>
            <div>
              <Label htmlFor="closeTime">Затваряне</Label>
              <Input id="closeTime" type="time" defaultValue="18:00" className="mt-1" />
            </div>
          </div>
        </section>

        <div className="flex items-center gap-3">
          <Button type="submit">Запази настройките</Button>
          {saved && <p className="text-sm text-green-600">Настройките са записани!</p>}
        </div>
      </form>
    </div>
  );
}
