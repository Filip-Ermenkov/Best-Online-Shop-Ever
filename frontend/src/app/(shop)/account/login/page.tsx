"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth, MOCK_CUSTOMER, MOCK_ADMIN } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    // Mock auth: admin@shop.bg → admin, anything else → customer
    if (email === "admin@shop.bg") {
      login(MOCK_ADMIN);
      router.push("/admin");
    } else if (email.includes("@")) {
      login(MOCK_CUSTOMER);
      router.push("/account/profile");
    } else {
      setError("Невалиден имейл или парола.");
    }
  }

  return (
    <div className="max-w-sm mx-auto px-4 py-12">
      <div className="text-center mb-8">
        <h1 className="text-2xl font-bold">Вход</h1>
        <p className="text-muted-foreground text-sm mt-1">Влезте в своя акаунт</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <Label htmlFor="email">Email</Label>
          <Input
            id="email" type="email" value={email}
            onChange={(e) => setEmail(e.target.value)}
            required autoFocus className="mt-1"
            placeholder="you@example.com"
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
            id="password" type="password" value={password}
            onChange={(e) => setPassword(e.target.value)}
            required className="mt-1"
          />
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <Button type="submit" className="w-full" size="lg">Вход</Button>
      </form>

      <div className="mt-4 text-xs text-muted-foreground bg-muted rounded-md p-3">
        <p className="font-medium mb-1">Demo акаунти:</p>
        <p>Клиент: всеки валиден email + произволна парола</p>
        <p>Администратор: admin@shop.bg</p>
      </div>

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
