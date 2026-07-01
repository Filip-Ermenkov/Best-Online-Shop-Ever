"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Separator } from "@/components/ui/separator";
import { formatCents } from "@/lib/utils";
import {
  cancelTrackedOrder,
  fetchTrackedOrder,
  fetchTrackWithdrawalEligibility,
  submitTrackWithdrawal,
} from "@/lib/track/client";
import type {
  OrderStatus,
  TrackWithdrawalEligibility,
  TrackWithdrawalRecord,
  TrackedOrder,
} from "@/lib/track/types";

const STATUS_LABELS: Record<OrderStatus, string> = {
  processing: "Обработва се",
  shipped: "Изпратена",
  ready_for_pickup: "Готова за вземане",
  delivered: "Доставена",
  accepted: "Приета",
  returned: "Върната",
  cancelled: "Отказана",
};

function sofia(iso: string): string {
  return new Date(iso).toLocaleString("bg-BG", { timeZone: "Europe/Sofia" });
}

export function TrackView({ token }: { token: string }) {
  const searchParams = useSearchParams();
  const justPlaced = searchParams.get("confirm") === "1";

  const [order, setOrder] = useState<TrackedOrder | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "not_found" | "error">(
    "loading",
  );
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetchTrackedOrder(token);
      if (cancelled) return;
      if (res.ok) {
        setOrder(res.value);
        setPhase("ready");
      } else {
        setPhase(res.error.kind === "not_found" ? "not_found" : "error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (phase === "loading") {
    return (
      <div className="max-w-3xl mx-auto px-4 py-12" aria-busy="true">
        <p className="text-muted-foreground">Зареждане на поръчката…</p>
      </div>
    );
  }

  if (phase === "not_found") {
    return (
      <div className="max-w-3xl mx-auto px-4 py-12 text-center">
        <h1 className="text-2xl font-semibold mb-2">Поръчката не е намерена</h1>
        <p className="text-muted-foreground mb-6">
          Линкът е невалиден или поръчката вече не съществува. Проверете дали сте
          отворили пълния линк от имейла.
        </p>
        <ButtonLink href="/track/find">Намери поръчката ми</ButtonLink>
      </div>
    );
  }

  if (phase === "error" || !order) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-12 text-center" role="alert">
        <h1 className="text-2xl font-semibold mb-2">Възникна грешка</h1>
        <p className="text-muted-foreground">
          Неуспешно зареждане на поръчката. Опитайте отново по-късно.
        </p>
      </div>
    );
  }

  // This branch renders only after the on-mount fetch resolves (client-side),
  // so `window` is always defined here — no SSR/hydration concern.
  const trackUrl = `${window.location.origin}/track/${token}`;
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(trackUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable (e.g. insecure context) — the link is shown
      // in full next to the button, so the user can still select + copy it.
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      {justPlaced && (
        <div
          className="mb-6 rounded-lg border border-green-600/40 bg-green-50 px-4 py-3 text-green-900"
          role="status"
        >
          <p className="font-medium">Благодарим за поръчката!</p>
          <p className="text-sm">
            Запазете този линк — той е единственият начин да проследите поръчката
            си без акаунт. Изпратихме го и на имейла Ви.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded bg-white/70 px-2 py-1 text-xs break-all">
              {trackUrl}
            </code>
            <Button type="button" variant="outline" onClick={copyLink}>
              {copied ? "Копирано!" : "Копирай"}
            </Button>
          </div>
        </div>
      )}

      <h1 className="text-2xl font-semibold">Поръчка {order.orderNumber}</h1>
      <p className="mt-1 text-muted-foreground">
        Статус: <span className="font-medium text-foreground">{STATUS_LABELS[order.status]}</span>
        {" · "}
        {sofia(order.createdAt)}
      </p>

      <ContactBlock order={order} />

      <Separator className="my-6" />

      <section aria-label="Продукти">
        <h2 className="text-lg font-medium mb-3">Продукти</h2>
        <ul className="space-y-2">
          {order.items.map((it, i) => (
            <li key={i} className="flex justify-between gap-4 text-sm">
              <span>
                {it.productName}{" "}
                <span className="text-muted-foreground">× {it.quantity}</span>
              </span>
              <span className="tabular-nums">
                {formatCents(it.unitPriceCents * it.quantity)}
              </span>
            </li>
          ))}
        </ul>
        <Separator className="my-3" />
        <div className="flex justify-between font-medium">
          <span>Общо</span>
          <span className="tabular-nums">{formatCents(order.totalCents)}</span>
        </div>
      </section>

      {order.deliveryAddress && (
        <section className="mt-6" aria-label="Доставка">
          <h2 className="text-lg font-medium mb-1">Адрес за доставка</h2>
          <p className="text-sm text-muted-foreground">
            {order.deliveryAddress.street}, {order.deliveryAddress.city}{" "}
            {order.deliveryAddress.postalCode}
            {order.deliveryAddress.apartmentOrOffice
              ? `, ${order.deliveryAddress.apartmentOrOffice}`
              : ""}
          </p>
        </section>
      )}

      <Timeline history={order.statusHistory} />

      <CancelSection order={order} token={token} onChange={setOrder} />

      <WithdrawalSection order={order} token={token} />
    </div>
  );
}

function ContactBlock({ order }: { order: TrackedOrder }) {
  // Spec §7: at "shipped" / "ready_for_pickup" show shop contact details.
  const show = order.status === "shipped" || order.status === "ready_for_pickup";
  return (
    <>
      {order.status === "shipped" && order.trackingNumber && (
        <p className="mt-2 text-sm">
          Куриер: <span className="font-medium">{order.courierCompany}</span> · Товарителница:{" "}
          <span className="font-medium">{order.trackingNumber}</span>
        </p>
      )}
      {order.status === "ready_for_pickup" && order.pickupDeadline && (
        <p className="mt-2 text-sm">
          Срок за вземане: <span className="font-medium">{sofia(order.pickupDeadline)}</span>
        </p>
      )}
      {show && (
        <div className="mt-3 rounded-md bg-muted/50 px-3 py-2 text-sm">
          <p className="font-medium">Връзка с магазина</p>
          {order.shopContact.address && (
            <p>Адрес: {order.shopContact.address}</p>
          )}
          {order.shopContact.hours && (
            <p>Работно време: {order.shopContact.hours}</p>
          )}
          <p>
            Имейл:{" "}
            <a className="underline" href={`mailto:${order.shopContact.email}`}>
              {order.shopContact.email}
            </a>
          </p>
          {order.shopContact.phone && (
            <p>
              Телефон:{" "}
              <a className="underline" href={`tel:${order.shopContact.phone.replace(/\s+/g, "")}`}>
                {order.shopContact.phone}
              </a>
            </p>
          )}
        </div>
      )}
    </>
  );
}

function Timeline({ history }: { history: TrackedOrder["statusHistory"] }) {
  if (history.length === 0) return null;
  return (
    <section className="mt-6" aria-label="История на статуса">
      <h2 className="text-lg font-medium mb-2">История</h2>
      <ol className="space-y-1 text-sm text-muted-foreground">
        {history.map((h, i) => (
          <li key={i}>
            {sofia(h.changedAt)} — {STATUS_LABELS[h.status]}
          </li>
        ))}
      </ol>
    </section>
  );
}

function CancelSection({
  order,
  token,
  onChange,
}: {
  order: TrackedOrder;
  token: string;
  onChange: (o: TrackedOrder) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!order.canCancel) return null;

  async function doCancel() {
    setBusy(true);
    setError(null);
    const res = await cancelTrackedOrder(token);
    setBusy(false);
    if (res.ok) {
      onChange(res.value);
      setConfirming(false);
    } else {
      setError(
        res.error.kind === "not_cancellable"
          ? "Поръчката вече не може да бъде анулирана онлайн. Свържете се с магазина."
          : "Неуспешно анулиране. Опитайте отново.",
      );
    }
  }

  return (
    <section className="mt-8 border-t pt-6">
      <h2 className="text-lg font-medium mb-2">Анулиране на поръчката</h2>
      <p className="text-sm text-muted-foreground mb-3">
        Можете да анулирате поръчката, докато е в статус „Обработва се“.
      </p>
      {error && (
        <p className="mb-3 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
      {!confirming ? (
        <Button variant="outline" onClick={() => setConfirming(true)}>
          Анулирай поръчката
        </Button>
      ) : (
        <div className="rounded-md border p-4">
          <p className="text-sm mb-3">
            Сигурни ли сте, че искате да анулирате поръчка {order.orderNumber} на
            стойност {formatCents(order.totalCents)}? Действието е необратимо.
          </p>
          <div className="flex gap-2">
            <Button onClick={doCancel} disabled={busy}>
              {busy ? "Анулиране…" : "Потвърди анулирането"}
            </Button>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={busy}>
              Назад
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function WithdrawalSection({ order, token }: { order: TrackedOrder; token: string }) {
  const [elig, setElig] = useState<TrackWithdrawalEligibility | null>(null);
  const [record, setRecord] = useState<TrackWithdrawalRecord | null>(null);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (order.status !== "accepted") return;
    let cancelled = false;
    (async () => {
      const res = await fetchTrackWithdrawalEligibility(token);
      if (!cancelled && res.ok) setElig(res.value);
    })();
    return () => {
      cancelled = true;
    };
  }, [order.status, token]);

  if (order.status !== "accepted" || !elig) return null;

  if (record || (elig.eligible && elig.alreadySubmittedAt)) {
    const when = record ? record.submittedAt : (elig.eligible ? elig.alreadySubmittedAt! : "");
    return (
      <section className="mt-8 border-t pt-6" role="status">
        <h2 className="text-lg font-medium mb-1">Рекламацията е получена</h2>
        <p className="text-sm text-muted-foreground">
          Подадена на {sofia(when)}. Ще се свържем с Вас по имейл или телефон.
        </p>
      </section>
    );
  }

  if (!elig.eligible) {
    return (
      <section className="mt-8 border-t pt-6">
        <h2 className="text-lg font-medium mb-1">Право на отказ</h2>
        <p className="text-sm text-muted-foreground">
          14-дневният срок за отказ от тази поръчка е изтекъл.
        </p>
      </section>
    );
  }

  async function doSubmit() {
    setBusy(true);
    setError(null);
    const res = await submitTrackWithdrawal(token, reason);
    setBusy(false);
    if (res.ok) {
      setRecord(res.value);
      setOpen(false);
    } else if (res.error.kind === "withdrawal_window_expired") {
      setError("Срокът за отказ е изтекъл.");
    } else {
      setError("Неуспешно подаване. Опитайте отново.");
    }
  }

  return (
    <section className="mt-8 border-t pt-6">
      <h2 className="text-lg font-medium mb-1">Право на отказ (14 дни)</h2>
      <p className="text-sm text-muted-foreground mb-3">
        Имате право да се откажете от поръчката до {sofia(elig.deadlineAt)} без да
        посочвате причина.
      </p>
      {error && (
        <p className="mb-3 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
      {!open ? (
        <Button variant="outline" onClick={() => setOpen(true)}>
          Подай рекламация / Върни стока
        </Button>
      ) : (
        <div className="rounded-md border p-4">
          <label htmlFor="withdrawal-reason" className="block text-sm font-medium mb-1">
            Причина (по избор)
          </label>
          <textarea
            id="withdrawal-reason"
            aria-label="Причина за отказ (по избор)"
            className="w-full rounded-md border px-3 py-2 text-sm"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={2000}
          />
          <div className="flex gap-2 mt-3">
            <Button onClick={doSubmit} disabled={busy}>
              {busy ? "Изпращане…" : "Изпрати"}
            </Button>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Назад
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
