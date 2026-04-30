"use client";

import { useState } from "react";
import Link from "next/link";
import { Mail, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ButtonLink } from "@/components/ui/button-link";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    await new Promise((r) => setTimeout(r, 900));
    setLoading(false);
    setSent(true);
  }

  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <ButtonLink variant="ghost" size="sm" href="/account/login" className="gap-1.5 mb-6 -ml-2">
          <ArrowLeft className="w-4 h-4" /> Обратно към вход
        </ButtonLink>

        <div className="mb-6">
          <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
            <Mail className="w-6 h-6 text-primary" />
          </div>
          <h1 className="text-2xl font-bold">Забравена парола</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Въведете имейла си и ще ви изпратим линк за нулиране на паролата.
          </p>
        </div>

        {sent ? (
          <div className="rounded-lg border border-green-200 bg-green-50 p-5 text-center space-y-2">
            <p className="font-semibold text-green-700">Имейлът е изпратен!</p>
            <p className="text-sm text-green-600">
              Проверете пощата си за линк за нулиране на паролата.
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              Не намирате имейла? Проверете папката &quot;Спам&quot;.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label htmlFor="email">Email адрес</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
                className="mt-1"
                placeholder="you@example.com"
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Изпращане..." : "Изпрати линк за нулиране"}
            </Button>
          </form>
        )}

        <p className="text-center text-sm text-muted-foreground mt-6">
          Спомнихте си паролата?{" "}
          <Link href="/account/login" className="text-primary hover:underline">
            Влезте тук
          </Link>
        </p>
      </div>
    </div>
  );
}
