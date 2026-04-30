"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth, MOCK_CUSTOMER } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

type AccountType = "personal" | "corporate";

export default function RegisterPage() {
  const router = useRouter();
  const { login } = useAuth();
  const [accountType, setAccountType] = useState<AccountType>("personal");
  const [form, setForm] = useState({
    firstName: "", lastName: "", email: "", phone: "",
    password: "", confirmPassword: "",
    companyName: "", vatNumber: "",
  });
  const [error, setError] = useState("");

  function setField(key: string, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (form.password !== form.confirmPassword) {
      setError("Паролите не съвпадат.");
      return;
    }
    // Mock: just log in
    login({ ...MOCK_CUSTOMER, email: form.email, firstName: form.firstName, lastName: form.lastName, accountType });
    router.push("/account/profile");
  }

  return (
    <div className="max-w-sm mx-auto px-4 py-12">
      <div className="text-center mb-8">
        <h1 className="text-2xl font-bold">Регистрация</h1>
        <p className="text-muted-foreground text-sm mt-1">Създайте безплатен акаунт</p>
      </div>

      {/* Account type toggle */}
      <div className="flex rounded-lg border border-border overflow-hidden mb-6">
        {(["personal", "corporate"] as const).map((type) => (
          <button
            key={type}
            type="button"
            onClick={() => setAccountType(type)}
            className={cn(
              "flex-1 py-2 text-sm font-medium transition-colors",
              accountType === type ? "bg-primary text-primary-foreground" : "hover:bg-muted"
            )}
          >
            {type === "personal" ? "Физическо лице" : "Фирма"}
          </button>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="firstName">Име</Label>
            <Input id="firstName" value={form.firstName} onChange={(e) => setField("firstName", e.target.value)} required className="mt-1" />
          </div>
          <div>
            <Label htmlFor="lastName">Фамилия</Label>
            <Input id="lastName" value={form.lastName} onChange={(e) => setField("lastName", e.target.value)} required className="mt-1" />
          </div>
        </div>
        <div>
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" value={form.email} onChange={(e) => setField("email", e.target.value)} required className="mt-1" />
        </div>
        <div>
          <Label htmlFor="phone">Телефон</Label>
          <Input id="phone" type="tel" value={form.phone} onChange={(e) => setField("phone", e.target.value)} className="mt-1" placeholder="+359 88 ..." />
        </div>

        {accountType === "corporate" && (
          <>
            <div>
              <Label htmlFor="companyName">Фирма</Label>
              <Input id="companyName" value={form.companyName} onChange={(e) => setField("companyName", e.target.value)} required className="mt-1" />
            </div>
            <div>
              <Label htmlFor="vatNumber">ДДС номер</Label>
              <Input id="vatNumber" value={form.vatNumber} onChange={(e) => setField("vatNumber", e.target.value)} className="mt-1" placeholder="BG..." />
            </div>
          </>
        )}

        <div>
          <Label htmlFor="password">Парола</Label>
          <Input id="password" type="password" value={form.password} onChange={(e) => setField("password", e.target.value)} required className="mt-1" />
        </div>
        <div>
          <Label htmlFor="confirmPassword">Потвърди паролата</Label>
          <Input id="confirmPassword" type="password" value={form.confirmPassword} onChange={(e) => setField("confirmPassword", e.target.value)} required className="mt-1" />
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <p className="text-xs text-muted-foreground">
          С регистрацията приемате нашите{" "}
          <Link href="/terms" className="text-primary hover:underline">Условия за ползване</Link>{" "}
          и{" "}
          <Link href="/privacy" className="text-primary hover:underline">Политика за поверителност</Link>.
        </p>

        <Button type="submit" className="w-full" size="lg">Регистрирай се</Button>
      </form>

      <Separator className="my-6" />
      <p className="text-center text-sm text-muted-foreground">
        Вече имате акаунт?{" "}
        <Link href="/account/login" className="text-primary hover:underline font-medium">Вход</Link>
      </p>
    </div>
  );
}
