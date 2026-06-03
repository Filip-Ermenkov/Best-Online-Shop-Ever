import { Users, Award, Truck, HeartHandshake } from "lucide-react";

export default function AboutPage() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-12">
      {/* Hero */}
      <div className="text-center mb-14">
        <h1 className="text-3xl sm:text-4xl font-bold mb-4">За нас</h1>
        <p className="text-muted-foreground text-lg max-w-2xl mx-auto leading-relaxed">
          Duda 1 е водещ онлайн магазин за електроника, инструменти, домакински уреди и спортно оборудване. Работим от 2018 г. с мисията да предоставяме качествени продукти на достъпни цени.
        </p>
      </div>

      {/* Values */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mb-14">
        {[
          { icon: Award, title: "Качество", description: "Работим само с проверени производители и доставяме оригинални продукти с пълна гаранция." },
          { icon: Truck, title: "Бърза доставка", description: "Поръчки направени до 14:00 ч. се обработват същия ден. Доставка в рамките на 24–48 часа." },
          { icon: HeartHandshake, title: "Клиентски сервиз", description: "Екипът ни е на ваше разположение 6 дни в седмицата за всякакви въпроси и рекламации." },
          { icon: Users, title: "Общност", description: "Над 15 000 доволни клиенти ни се доверяват всеки месец. Присъединете се към нашата общност." },
        ].map(({ icon: Icon, title, description }) => (
          <div key={title} className="flex gap-4 rounded-lg border border-border bg-card p-5 card-lift">
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
              <Icon className="w-5 h-5 text-primary-strong" />
            </div>
            <div>
              <h3 className="font-semibold mb-1">{title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">{description}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Story */}
      <div className="rounded-lg border border-border bg-card p-8 mb-10">
        <h2 className="text-xl font-bold mb-4">Нашата история</h2>
        <div className="space-y-3 text-sm text-muted-foreground leading-relaxed">
          <p>
            Duda 1 беше основан през 2018 г. от екип от ентусиасти с опит в търговията с техника. Започнахме с малък склад в София и ограничен асортимент от електроника.
          </p>
          <p>
            Днес разполагаме с над 5 000 активни артикула в 5 основни категории, собствен логистичен център и партньорства с водещи куриерски фирми за цялата страна.
          </p>
          <p>
            Мисията ни остава непроменена — да правим онлайн пазаруването лесно, достъпно и приятно за всеки български потребител.
          </p>
        </div>
      </div>

      {/* Team teaser */}
      <div className="text-center">
        <h2 className="text-xl font-bold mb-2">Работи ли при нас?</h2>
        <p className="text-muted-foreground text-sm">Търсим мотивирани хора в сферата на логистиката, IT и продажбите.</p>
        <a href="mailto:careers@duda1.bg" className="inline-block mt-4 text-primary-strong underline text-sm font-medium">
          careers@duda1.bg
        </a>
      </div>
    </div>
  );
}
