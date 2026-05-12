import { Truck, Store, Clock, RotateCcw, Package } from "lucide-react";

export default function DeliveryPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-12">
      <h1 className="text-3xl font-bold mb-2">Доставка и връщане</h1>
      <p className="text-muted-foreground mb-10">Всичко, което трябва да знаете за доставката и правото ви на връщане.</p>

      <div className="space-y-8">
        {/* Delivery methods */}
        <section>
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2"><Truck className="w-5 h-5 text-primary" /> Начини на доставка</h2>
          <div className="space-y-3">
            {[
              { title: "Куриер Еконт", description: "Доставка до адрес или офис на Еконт на следващия работен ден при поръчка до 14:00 ч.", price: "Безплатно при поръчка над 100 EUR, иначе 5 EUR" },
              { title: "Куриер Спиди", description: "Доставка до адрес или офис на Спиди в рамките на 1–2 работни дни.", price: "Безплатно при поръчка над 100 EUR, иначе 5 EUR" },
              { title: "Вземане от магазин", description: "Вземете поръчката си лично от нашия шоурум в София. Поръчката е готова до 4 часа.", price: "Безплатно" },
            ].map(({ title, description, price }) => (
              <div key={title} className="rounded-lg border border-border bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold text-sm">{title}</h3>
                    <p className="text-sm text-muted-foreground mt-1">{description}</p>
                  </div>
                  <span className="text-sm font-medium text-primary whitespace-nowrap">{price}</span>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Timelines */}
        <section>
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2"><Clock className="w-5 h-5 text-primary" /> Срокове за доставка</h2>
          <div className="rounded-lg border border-border bg-card p-5 space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Поръчки до 14:00 ч.</span>
              <span className="font-medium">Изпращане същия ден</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Поръчки след 14:00 ч.</span>
              <span className="font-medium">Изпращане на следващия ден</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Доставка до адрес</span>
              <span className="font-medium">1–2 работни дни</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Доставка до офис</span>
              <span className="font-medium">1 работен ден</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Вземане от магазин</span>
              <span className="font-medium">До 4 часа</span>
            </div>
          </div>
        </section>

        {/* Returns */}
        <section>
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2"><RotateCcw className="w-5 h-5 text-primary" /> Право на отказ (14 дни)</h2>
          <div className="rounded-lg border border-border bg-card p-5 space-y-3 text-sm text-muted-foreground leading-relaxed">
            <p>Имате право да се откажете от договора в рамките на <strong className="text-foreground">14 дни</strong> от получаването на стоката без да посочвате причина.</p>
            <p>За да упражните правото си, отворете поръчката в <a href="/account/orders" className="text-primary underline underline-offset-2">История на поръчките</a> и натиснете <strong className="text-foreground">„Откажете се от договора тук"</strong>. Ще получите потвърждение на екрана и копие по имейл с дата и час на подаване.</p>
            <p>Подробните условия и стандартният формуляр за отказ са публикувани на <a href="/terms/withdrawal" className="text-primary underline underline-offset-2">страницата за правото на отказ</a>.</p>
          </div>
        </section>

        {/* Tracking */}
        <section>
          <h2 className="text-xl font-semibold mb-4 flex items-center gap-2"><Package className="w-5 h-5 text-primary" /> Проследяване на пратка</h2>
          <p className="text-sm text-muted-foreground">
            След изпращане на поръчката ще получите имейл с номер за проследяване. Можете да следите статуса на пратката директно в профила си или на сайта на съответния куриер.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold mb-2 flex items-center gap-2"><Store className="w-5 h-5 text-primary" /> Адрес на магазина</h2>
          <p className="text-sm text-muted-foreground">ул. Витоша 15, 1000 София · Пн–Пт: 9:00–18:00 · Съб: 10:00–14:00</p>
        </section>
      </div>
    </div>
  );
}
