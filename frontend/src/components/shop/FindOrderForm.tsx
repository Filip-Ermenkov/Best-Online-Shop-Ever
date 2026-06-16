"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { findMyOrder } from "@/lib/track/client";

export function FindOrderForm() {
  const [orderNumber, setOrderNumber] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  // "sent" is shown for BOTH a match and a non-match — the API is
  // enumeration-resistant and so is this UI.
  const [phase, setPhase] = useState<"idle" | "sent" | "rate_limited" | "error">(
    "idle",
  );

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const res = await findMyOrder(orderNumber, email);
    setBusy(false);
    if (res.ok) {
      setPhase("sent");
    } else if (res.error.kind === "rate_limited") {
      setPhase("rate_limited");
    } else {
      setPhase("error");
    }
  }

  if (phase === "sent") {
    return (
      <div className="rounded-md border border-green-600/40 bg-green-50 px-4 py-3 text-green-900" role="status">
        <p className="font-medium">Готово</p>
        <p className="text-sm">
          Ако намерим поръчка с тези данни, изпратихме линка за проследяване на
          посочения имейл. Проверете и папката „Спам“.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      {phase === "rate_limited" && (
        <p className="text-sm text-red-700" role="alert">
          Твърде много опити. Опитайте отново след около час.
        </p>
      )}
      {phase === "error" && (
        <p className="text-sm text-red-700" role="alert">
          Възникна грешка. Опитайте отново.
        </p>
      )}
      <div>
        <label htmlFor="order-number" className="block text-sm font-medium mb-1">
          Номер на поръчка
        </label>
        <input
          id="order-number"
          aria-label="Номер на поръчка"
          className="w-full rounded-md border px-3 py-2 text-sm"
          value={orderNumber}
          onChange={(e) => setOrderNumber(e.target.value)}
          placeholder="2026-06-00123"
          required
        />
      </div>
      <div>
        <label htmlFor="find-email" className="block text-sm font-medium mb-1">
          Имейл
        </label>
        <input
          id="find-email"
          type="email"
          aria-label="Имейл"
          className="w-full rounded-md border px-3 py-2 text-sm"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          required
        />
      </div>
      <Button type="submit" disabled={busy || !orderNumber || !email}>
        {busy ? "Изпращане…" : "Изпрати линка"}
      </Button>
    </form>
  );
}
