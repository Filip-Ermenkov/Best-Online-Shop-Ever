"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle,
  FileText,
  Info,
  Mail,
  Package,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import {
  fetchOrder,
  fetchWithdrawal,
  fetchWithdrawalEligibility,
  submitWithdrawal,
} from "@/lib/orders/client";
import type {
  OrderDTO,
  WithdrawalEligibility,
  WithdrawalRecord,
} from "@/lib/orders/types";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { formatCents } from "@/lib/utils";

/**
 * /account/orders/[id]/withdrawal
 *
 * The "withdrawal button" surface required by EU Directive 2023/2673 /
 * Art. 11a of the Consumer Rights Directive (2011/83/EU), mandatory from
 * 19 June 2026. This page IS the digital withdrawal function: it lets an
 * authenticated consumer (i) identify the contract being withdrawn from
 * (the order is shown in the summary), (ii) submit an unambiguous
 * withdrawal statement (via a single labelled button — no double-confirm,
 * no nag copy), and (iii) receive an acknowledgement on a durable medium
 * (this page's success state IS the primary durable medium; the
 * confirmation email is defence in depth).
 *
 * Page lifecycle (declarative state machine):
 *
 *   - `loading`              → both order detail and eligibility loading
 *   - `order_not_found`      → 404 on order GET, OR not-yours
 *   - `not_accepted`         → order exists but isn't in `accepted` status
 *   - `window_expired`       → 14-day window is over, no prior submission
 *   - `already_submitted`    → a withdrawal exists; render the receipt
 *   - `form`                 → eligible, no submission yet — show the form
 *   - `submitting`           → the POST is in flight
 *   - `submitted` (terminal) → just submitted; render fresh receipt
 *
 * Recital 37 anti-dark-pattern rules baked in:
 *   - No "Are you sure?" interstitial. The form's primary CTA is a single
 *     unambiguous click → submit. The user already knows what they want.
 *   - No "Would you like to keep the goods at half price?" upsell.
 *   - No timer pressuring the user.
 *   - No confusing button labels — the CTA is literally "Откажете се от
 *     договора" (the Bulgarian rendering of "withdraw from the contract"
 *     specifically required by Art. 11a(1)(a)).
 */

type PageState =
  | { kind: "loading" }
  | { kind: "order_not_found" }
  | { kind: "not_accepted" }
  | { kind: "window_expired" }
  | {
      kind: "already_submitted";
      order: OrderDTO;
      record: WithdrawalRecord;
      eligibility: Extract<WithdrawalEligibility, { eligible: true }>;
    }
  | {
      kind: "form";
      order: OrderDTO;
      eligibility: Extract<WithdrawalEligibility, { eligible: true }>;
    }
  | {
      kind: "submitting";
      order: OrderDTO;
      eligibility: Extract<WithdrawalEligibility, { eligible: true }>;
    }
  | {
      kind: "submitted";
      order: OrderDTO;
      record: WithdrawalRecord;
    }
  | { kind: "error"; message: string };

interface Props {
  params: Promise<{ id: string }>;
}

export default function WithdrawalPage({ params }: Props) {
  const { id: orderNumber } = use(params);
  const router = useRouter();
  const { isLoggedIn, status: authStatus } = useAuth();

  const [state, setState] = useState<PageState>({ kind: "loading" });
  const [reason, setReason] = useState("");

  // Auth gate — same pattern as the order detail page.
  useEffect(() => {
    if (authStatus === "loading") return;
    if (!isLoggedIn) {
      router.push(
        `/account/login?next=${encodeURIComponent(
          `/account/orders/${orderNumber}/withdrawal`,
        )}`,
      );
    }
  }, [authStatus, isLoggedIn, orderNumber, router]);

  // Initial load: fetch order detail + eligibility + any existing record
  // in parallel. The eligibility response carries `alreadySubmittedAt` so
  // we know whether to fetch the record at all — saves a round trip on the
  // common "no submission yet" path.
  useEffect(() => {
    if (!isLoggedIn) return;
    let cancelled = false;
    (async () => {
      const [orderRes, eligibilityRes] = await Promise.all([
        fetchOrder(orderNumber),
        fetchWithdrawalEligibility(orderNumber),
      ]);
      if (cancelled) return;

      if (!orderRes.ok) {
        if (orderRes.error.kind === "not_found") {
          setState({ kind: "order_not_found" });
        } else if (orderRes.error.kind === "unauthenticated") {
          router.push(
            `/account/login?next=${encodeURIComponent(
              `/account/orders/${orderNumber}/withdrawal`,
            )}`,
          );
        } else {
          setState({
            kind: "error",
            message:
              orderRes.error.kind === "network"
                ? "Не може да се свърже със сървъра. Опитайте отново."
                : "Възникна неочаквана грешка. Опитайте отново по-късно.",
          });
        }
        return;
      }

      if (!eligibilityRes.ok) {
        if (eligibilityRes.error.kind === "not_found") {
          setState({ kind: "order_not_found" });
        } else {
          setState({
            kind: "error",
            message:
              eligibilityRes.error.kind === "network"
                ? "Не може да се свърже със сървъра. Опитайте отново."
                : "Възникна неочаквана грешка. Опитайте отново по-късно.",
          });
        }
        return;
      }

      const order = orderRes.value;
      const eligibility = eligibilityRes.value;

      if (!eligibility.eligible) {
        if (eligibility.reason === "window_expired")
          setState({ kind: "window_expired" });
        else setState({ kind: "not_accepted" });
        return;
      }

      if (eligibility.alreadySubmittedAt) {
        // Fetch the record so we can show its content + receipt timestamp.
        const recordRes = await fetchWithdrawal(orderNumber);
        if (cancelled) return;
        if (recordRes.ok) {
          setState({
            kind: "already_submitted",
            order,
            record: recordRes.value,
            eligibility,
          });
        } else {
          // Race / data inconsistency. Fall back to the form.
          setState({ kind: "form", order, eligibility });
        }
        return;
      }

      setState({ kind: "form", order, eligibility });
    })();
    return () => {
      cancelled = true;
    };
  }, [isLoggedIn, orderNumber, router]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (state.kind !== "form") return;
    const { order, eligibility } = state;
    setState({ kind: "submitting", order, eligibility });
    const res = await submitWithdrawal(orderNumber, { reason });
    if (res.ok) {
      setState({ kind: "submitted", order, record: res.value });
      return;
    }
    if (res.error.kind === "unauthenticated") {
      router.push(
        `/account/login?next=${encodeURIComponent(
          `/account/orders/${orderNumber}/withdrawal`,
        )}`,
      );
      return;
    }
    if (res.error.kind === "withdrawal_window_expired") {
      setState({ kind: "window_expired" });
      return;
    }
    if (res.error.kind === "withdrawal_not_accepted") {
      setState({ kind: "not_accepted" });
      return;
    }
    if (res.error.kind === "not_found") {
      setState({ kind: "order_not_found" });
      return;
    }
    setState({
      kind: "error",
      message:
        res.error.kind === "network"
          ? "Не може да се свърже със сървъра. Опитайте отново."
          : "Възникна неочаквана грешка при изпращането. Опитайте отново.",
    });
  };

  // ─── Render ────────────────────────────────────────────────────────────

  if (authStatus === "loading" || state.kind === "loading") {
    return (
      <div className="max-w-2xl mx-auto px-4 py-8 space-y-6">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-40 w-full rounded-lg" />
        <Skeleton className="h-32 w-full rounded-lg" />
      </div>
    );
  }

  if (!isLoggedIn) return null;

  if (state.kind === "order_not_found") {
    return (
      <CenteredMessage
        icon={<Package className="w-12 h-12 text-muted-foreground/40 mx-auto mb-4" />}
        title="Поръчката не е намерена"
        body={`Поръчка с номер ${orderNumber} не съществува или принадлежи на друг акаунт.`}
        cta={
          <ButtonLink href="/account/orders">Към моите поръчки</ButtonLink>
        }
      />
    );
  }

  if (state.kind === "not_accepted") {
    return (
      <CenteredMessage
        icon={<Info className="w-12 h-12 text-blue-500/70 mx-auto mb-4" />}
        title="Отказът все още не е достъпен"
        body="14-дневният срок за отказ започва от датата, на която поръчката бъде маркирана като приета. Ще видите бутона тук, когато стане възможно."
        cta={
          <ButtonLink href={`/account/orders/${orderNumber}`}>
            Към детайлите на поръчката
          </ButtonLink>
        }
      />
    );
  }

  if (state.kind === "window_expired") {
    return (
      <CenteredMessage
        icon={<AlertCircle className="w-12 h-12 text-amber-500/70 mx-auto mb-4" />}
        title="Срокът за отказ е изтекъл"
        body="14-дневният срок за упражняване на правото на отказ за тази поръчка е изтекъл. Ако имате проблем със стоката, моля свържете се директно с нас."
        cta={
          <ButtonLink href={`/account/orders/${orderNumber}`}>
            Към детайлите на поръчката
          </ButtonLink>
        }
      />
    );
  }

  if (state.kind === "error") {
    return (
      <CenteredMessage
        icon={<AlertCircle className="w-12 h-12 text-destructive/70 mx-auto mb-4" />}
        title="Възникна грешка"
        body={state.message}
        cta={
          <Button onClick={() => router.refresh()}>Опитай отново</Button>
        }
      />
    );
  }

  if (state.kind === "already_submitted") {
    return (
      <ReceiptView
        orderNumber={orderNumber}
        order={state.order}
        record={state.record}
        justSubmitted={false}
      />
    );
  }

  if (state.kind === "submitted") {
    return (
      <ReceiptView
        orderNumber={orderNumber}
        order={state.order}
        record={state.record}
        justSubmitted={true}
      />
    );
  }

  // form OR submitting
  const submitting = state.kind === "submitting";
  const { order, eligibility } = state;

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <Breadcrumb className="mb-6">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink render={<Link href="/account/orders" />}>
              Поръчки
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink
              render={<Link href={`/account/orders/${orderNumber}`} />}
            >
              {orderNumber}
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Отказ от договора</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <header className="mb-6">
        <h1 className="text-2xl font-bold">Отказ от договора</h1>
        <p className="text-sm text-muted-foreground mt-2">
          14-дневно право на отказ по чл. 50 от Закона за защита на потребителите
          (EU Directive 2011/83 / 2023/2673).{" "}
          <Link
            href="/terms/withdrawal"
            className="underline underline-offset-2 hover:text-foreground"
          >
            Прочетете пълните условия
          </Link>
          .
        </p>
      </header>

      <OrderSummaryCard order={order} />

      <DeadlineNotice deadlineAt={eligibility.deadlineAt} />

      <form onSubmit={handleSubmit} className="mt-6 space-y-5">
        <div className="rounded-lg border border-border p-4 space-y-3">
          <Label htmlFor="reason" className="text-sm font-medium">
            Причина <span className="text-muted-foreground">(по избор)</span>
          </Label>
          <Textarea
            id="reason"
            name="reason"
            placeholder="Не сте задължени да посочвате причина. Ако желаете, можете да оставите кратко обяснение, което ще помогне на екипа ни да обработи заявката Ви."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={2000}
            disabled={submitting}
            className="min-h-24"
          />
          <p className="text-xs text-muted-foreground">
            По закон не сте длъжни да посочвате причина за отказа. Информацията е
            опционална и ще се използва само за подобряване на услугата.
          </p>
        </div>

        <div className="flex flex-col-reverse sm:flex-row gap-3">
          <ButtonLink
            variant="outline"
            href={`/account/orders/${orderNumber}`}
            className="gap-2 sm:flex-1"
          >
            <ArrowLeft className="w-4 h-4" />
            Назад към поръчката
          </ButtonLink>
          <Button
            type="submit"
            disabled={submitting}
            className="sm:flex-1"
            aria-label="Откажете се от договора тук"
          >
            {submitting ? "Изпращане…" : "Откажете се от договора"}
          </Button>
        </div>
      </form>
    </div>
  );
}

// ─── Subcomponents ───────────────────────────────────────────────────────

function OrderSummaryCard({ order }: { order: OrderDTO }) {
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold">Поръчка {order.orderNumber}</h2>
        <span className="text-sm font-semibold text-primary">
          {formatCents(order.totalCents)}
        </span>
      </div>
      <ul className="space-y-2 text-sm">
        {order.items.map((it) => (
          <li
            key={it.productCode}
            className="flex items-center justify-between gap-3"
          >
            <span className="truncate text-muted-foreground">
              {it.productName}
            </span>
            <span className="flex-shrink-0">
              {it.quantity} бр. × {formatCents(it.unitPriceCents)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DeadlineNotice({ deadlineAt }: { deadlineAt: string }) {
  // Render the deadline in Sofia local time. The customer's expectation is
  // local-shop time; the calculation already happened on the server, we
  // just format it for display.
  const fmt = new Intl.DateTimeFormat("bg-BG", {
    timeZone: "Europe/Sofia",
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const deadline = fmt.format(new Date(deadlineAt));
  return (
    <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-4 flex items-start gap-3">
      <Info className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
      <div className="text-sm">
        <p className="font-medium text-blue-900">
          Срокът за отказ изтича на {deadline} ч. (часова зона София).
        </p>
        <p className="text-blue-800 mt-0.5">
          Можете да упражните правото си на отказ без да посочвате причина и без
          допълнителни такси.
        </p>
      </div>
    </div>
  );
}

function ReceiptView({
  orderNumber,
  order,
  record,
  justSubmitted,
}: {
  orderNumber: string;
  order: OrderDTO;
  record: WithdrawalRecord;
  justSubmitted: boolean;
}) {
  // Durable-medium timestamp — exactly the format the backend uses in the
  // confirmation email so the on-screen receipt and emailed receipt agree
  // on the second. Art. 11a(2) wants date+time of receipt.
  const fmt = new Intl.DateTimeFormat("bg-BG", {
    timeZone: "Europe/Sofia",
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const submittedAtLocal = fmt.format(new Date(record.submittedAt));

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <Breadcrumb className="mb-6">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink render={<Link href="/account/orders" />}>
              Поръчки
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink
              render={<Link href={`/account/orders/${orderNumber}`} />}
            >
              {orderNumber}
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Отказ от договора</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="rounded-lg border border-green-200 bg-green-50 p-5 mb-6 flex items-start gap-3">
        <CheckCircle className="w-6 h-6 text-green-600 flex-shrink-0 mt-0.5" />
        <div>
          <h1 className="text-lg font-semibold text-green-900">
            {justSubmitted
              ? "Получихме Вашия отказ"
              : "Отказ от договора е подаден"}
          </h1>
          <p className="text-sm text-green-800 mt-1">
            Това потвърждение е приетата от закона документална форма
            (чл. 50, ал. 4 от ЗЗП — „траен носител&rdquo;). Запазете го като
            доказателство за подадения отказ.
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-border p-4 mb-6">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          Данни за заявката
        </h2>
        <dl className="grid grid-cols-[180px_1fr] gap-y-2 text-sm">
          <dt className="text-muted-foreground">Номер на поръчка:</dt>
          <dd className="font-mono">{record.orderNumber}</dd>
          <dt className="text-muted-foreground">Дата и час на получаване:</dt>
          <dd>
            <strong>{submittedAtLocal}</strong>
            <span className="block text-xs text-muted-foreground mt-0.5">
              часова зона Европа/София
            </span>
          </dd>
          <dt className="text-muted-foreground">Имейл:</dt>
          <dd>{record.customerEmail}</dd>
          <dt className="text-muted-foreground">Име:</dt>
          <dd>{record.customerName}</dd>
          <dt className="text-muted-foreground">Телефон:</dt>
          <dd>{record.customerPhone}</dd>
          {record.reason && (
            <>
              <dt className="text-muted-foreground self-start">
                Посочена причина:
              </dt>
              <dd className="whitespace-pre-wrap">{record.reason}</dd>
            </>
          )}
        </dl>
      </div>

      <div className="rounded-lg border border-border p-4 mb-6">
        <h2 className="font-semibold mb-3 flex items-center gap-2">
          <FileText className="w-4 h-4" /> Какво следва
        </h2>
        <ol className="list-decimal pl-5 space-y-2 text-sm text-muted-foreground">
          <li>
            Свържете се с нас, за да уговорим връщането на стоката (ако вече сте я
            получили).
          </li>
          <li>
            Възстановяването на сумата ще бъде извършено в срок до 14 дни от
            получаването на стоката обратно (или от получаването на доказателство,
            че сте я изпратили — което настъпи първо).
          </li>
          <li>
            Запазете това потвърждение като доказателство за подадения отказ.
          </li>
        </ol>
      </div>

      {record.acknowledgedAt && (
        <div className="rounded-lg border border-border p-4 mb-6 flex items-start gap-3">
          <Mail className="w-5 h-5 text-muted-foreground flex-shrink-0 mt-0.5" />
          <p className="text-sm text-muted-foreground">
            Копие на това потвърждение също беше изпратено на{" "}
            <strong className="text-foreground">{record.customerEmail}</strong>.
            Проверете и папката за спам, ако не го виждате.
          </p>
        </div>
      )}

      <OrderSummaryCard order={order} />

      <div className="mt-6 flex flex-col-reverse sm:flex-row gap-3">
        <ButtonLink
          variant="outline"
          href={`/account/orders/${orderNumber}`}
          className="gap-2"
        >
          <ArrowLeft className="w-4 h-4" /> Към поръчката
        </ButtonLink>
        <ButtonLink href="/account/orders" className="sm:ml-auto">
          Всички поръчки
        </ButtonLink>
      </div>
    </div>
  );
}

function CenteredMessage({
  icon,
  title,
  body,
  cta,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  cta: React.ReactNode;
}) {
  return (
    <div className="max-w-md mx-auto px-4 py-20 text-center">
      {icon}
      <h1 className="text-xl font-bold mb-2">{title}</h1>
      <p className="text-muted-foreground mb-6 text-sm">{body}</p>
      {cta}
    </div>
  );
}
