"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

const faqs = [
  {
    category: "Поръчки",
    items: [
      { q: "Как да направя поръчка?", a: "Добавете желаните продукти в количката и следвайте стъпките при оформяне на поръчката — попълнете данните си, изберете начин на доставка и платете." },
      { q: "Мога ли да поръчам без регистрация?", a: "Да, предлагаме гостуваща поръчка. Регистрацията е незадължителна, но дава предимства като история на поръчките и персонални отстъпки." },
      { q: "Как да проследя поръчката си?", a: "След изпращане ще получите имейл с номер за проследяване. Влезте в профила си в раздел \"Моите поръчки\" за актуален статус." },
      { q: "Мога ли да анулирам поръчка?", a: "Поръчки могат да се анулират, докато са в статус \"Обработва се\". За помощ се свържете с нас по имейл или телефон." },
    ],
  },
  {
    category: "Доставка",
    items: [
      { q: "Колко струва доставката?", a: "Доставката е безплатна при поръчки над 100 EUR. При по-малки суми — 5 EUR с Еконт или Спиди." },
      { q: "В какъв срок ще получа поръчката?", a: "При поръчка до 14:00 ч. — изпращаме същия ден. Доставката до адрес е 1–2 работни дни, до офис — 1 работен ден." },
      { q: "Доставяте ли извън България?", a: "Засега доставяме само в рамките на България." },
    ],
  },
  {
    category: "Плащане",
    items: [
      { q: "Какви начини на плащане приемате?", a: "Приемаме наложен платеж (плащате при получаване) и плащане на място при вземане от магазина." },
      { q: "Безопасно ли е плащането?", a: "Всички транзакции са защитени. Не съхраняваме данни от карти." },
    ],
  },
  {
    category: "Връщане и гаранция",
    items: [
      { q: "Какъв е срокът за връщане?", a: "14 дни от получаването на продукта, при условие, че е в оригиналната опаковка и неизползван." },
      { q: "Как да върна продукт?", a: "Свържете се с нас на info@duda1.bg или +359 2 900 1234. Ще ви изпратим инструкции и адрес за връщане." },
      { q: "Кога ще получа парите обратно?", a: "5–10 работни дни след получаване и проверка на върнатия продукт." },
    ],
  },
];

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-border last:border-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 py-4 text-left text-sm font-medium hover:text-primary-strong transition-colors"
      >
        <span>{q}</span>
        <ChevronDown className={cn("w-4 h-4 flex-shrink-0 transition-transform text-muted-foreground", open && "rotate-180")} />
      </button>
      {open && (
        <p className="pb-4 text-sm text-muted-foreground leading-relaxed">{a}</p>
      )}
    </div>
  );
}

export default function FaqPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-12">
      <h1 className="text-3xl font-bold mb-2">Често задавани въпроси</h1>
      <p className="text-muted-foreground mb-10">Отговори на най-честите въпроси от нашите клиенти.</p>

      <div className="space-y-8">
        {faqs.map(({ category, items }) => (
          <section key={category}>
            <h2 className="text-lg font-semibold text-primary-strong mb-2">{category}</h2>
            <div className="rounded-lg border border-border bg-card px-4">
              {items.map(({ q, a }) => (
                <FaqItem key={q} q={q} a={a} />
              ))}
            </div>
          </section>
        ))}
      </div>

      <div className="mt-12 rounded-lg border border-border bg-muted/50 p-6 text-center">
        <p className="font-semibold mb-1">Не намерихте отговор?</p>
        <p className="text-sm text-muted-foreground mb-3">Свържете се с нас и ще ви помогнем.</p>
        <a href="/contact" className="text-sm text-primary-strong font-medium underline">Страница за контакт →</a>
      </div>
    </div>
  );
}
