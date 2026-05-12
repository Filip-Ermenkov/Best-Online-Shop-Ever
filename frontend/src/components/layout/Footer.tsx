import Link from "next/link";
import { MapPin, Phone, Mail, ShieldCheck, Truck, RotateCcw, CreditCard, Wallet } from "lucide-react";

export default function Footer() {
  return (
    <footer className="mt-auto bg-[oklch(0.18_0.02_270)] text-[oklch(0.96_0.005_270)]">
      {/* Trust strip */}
      <div className="border-b border-white/10">
        <div className="max-w-7xl mx-auto px-4 py-5 grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[
            { icon: Truck, title: "Бърза доставка", text: "1–3 работни дни в цялата страна" },
            { icon: RotateCcw, title: "14 дни връщане", text: "Безплатно връщане на продукти" },
            { icon: ShieldCheck, title: "Сигурни плащания", text: "SSL криптирани транзакции" },
          ].map(({ icon: Icon, title, text }) => (
            <div key={title} className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-[oklch(0.73_0.10_75)]/15 flex items-center justify-center flex-shrink-0">
                <Icon className="w-5 h-5 text-[oklch(0.73_0.10_75)]" />
              </div>
              <div>
                <p className="text-sm font-semibold">{title}</p>
                <p className="text-xs text-[oklch(0.60_0.02_270)]">{text}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Main links */}
      <div className="max-w-7xl mx-auto px-4 py-12">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8 lg:gap-12">
          {/* Brand + business info */}
          <div className="col-span-2 md:col-span-1">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-9 h-9 rounded bg-[oklch(0.73_0.10_75)] flex items-center justify-center text-[oklch(0.18_0.02_270)] font-bold text-sm">
                D
              </div>
              <span className="font-bold text-base tracking-wide">Duda 1</span>
            </div>
            <p className="text-sm text-[oklch(0.60_0.02_270)] leading-relaxed mb-4">
              Вашият надежден онлайн магазин за електроника, инструменти, домакински уреди и още.
            </p>
            <dl className="text-xs text-[oklch(0.60_0.02_270)] space-y-1">
              <div className="flex gap-2">
                <dt className="font-semibold text-[oklch(0.73_0.10_75)]">ЕИК:</dt>
                <dd>123456789</dd>
              </div>
              <div className="flex gap-2">
                <dt className="font-semibold text-[oklch(0.73_0.10_75)]">ДДС №:</dt>
                <dd>BG123456789</dd>
              </div>
              <div className="flex gap-2">
                <dt className="font-semibold text-[oklch(0.73_0.10_75)]">МОЛ:</dt>
                <dd>Иван Иванов</dd>
              </div>
            </dl>
          </div>

          {/* За нас */}
          <div>
            <h3 className="font-semibold text-sm mb-4 text-[oklch(0.73_0.10_75)] uppercase tracking-wider">За нас</h3>
            <ul className="space-y-2.5 text-sm text-[oklch(0.60_0.02_270)]">
              <li><Link href="/about" className="hover:text-[oklch(0.73_0.10_75)] transition-colors">За компанията</Link></li>
              <li><Link href="/contact" className="hover:text-[oklch(0.73_0.10_75)] transition-colors">Контакти</Link></li>
              <li><Link href="/account/register" className="hover:text-[oklch(0.73_0.10_75)] transition-colors">Регистрация</Link></li>
            </ul>
          </div>

          {/* Помощ */}
          <div>
            <h3 className="font-semibold text-sm mb-4 text-[oklch(0.73_0.10_75)] uppercase tracking-wider">Помощ</h3>
            <ul className="space-y-2.5 text-sm text-[oklch(0.60_0.02_270)]">
              <li><Link href="/faq" className="hover:text-[oklch(0.73_0.10_75)] transition-colors">Често задавани въпроси</Link></li>
              <li><Link href="/delivery" className="hover:text-[oklch(0.73_0.10_75)] transition-colors">Доставка и връщане</Link></li>
              <li><Link href="/terms/withdrawal" className="hover:text-[oklch(0.73_0.10_75)] transition-colors">Право на отказ (14 дни)</Link></li>
              <li><Link href="/account/orders" className="hover:text-[oklch(0.73_0.10_75)] transition-colors">Проследяване на поръчка</Link></li>
              <li><Link href="/terms" className="hover:text-[oklch(0.73_0.10_75)] transition-colors">Условия за ползване</Link></li>
              <li><Link href="/privacy" className="hover:text-[oklch(0.73_0.10_75)] transition-colors">Поверителност</Link></li>
            </ul>
          </div>

          {/* Контакти + Социални */}
          <div>
            <h3 className="font-semibold text-sm mb-4 text-[oklch(0.73_0.10_75)] uppercase tracking-wider">Контакти</h3>
            <ul className="space-y-3 text-sm text-[oklch(0.60_0.02_270)] mb-5">
              <li className="flex items-start gap-2">
                <MapPin className="w-4 h-4 mt-0.5 flex-shrink-0 text-[oklch(0.73_0.10_75)]" />
                <span>ул. Витоша 15, София 1000</span>
              </li>
              <li className="flex items-center gap-2">
                <Phone className="w-4 h-4 flex-shrink-0 text-[oklch(0.73_0.10_75)]" />
                <a href="tel:+35929001234" className="hover:text-[oklch(0.73_0.10_75)] transition-colors">+359 2 900 1234</a>
              </li>
              <li className="flex items-center gap-2">
                <Mail className="w-4 h-4 flex-shrink-0 text-[oklch(0.73_0.10_75)]" />
                <a href="mailto:info@duda1.bg" className="hover:text-[oklch(0.73_0.10_75)] transition-colors">info@duda1.bg</a>
              </li>
            </ul>

            {/* Social */}
            <div>
              <h4 className="font-semibold text-xs mb-2 text-[oklch(0.73_0.10_75)] uppercase tracking-wider">Последвайте ни</h4>
              <div className="flex gap-2">
                <a
                  href="https://facebook.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Facebook"
                  className="w-9 h-9 rounded-full bg-white/5 hover:bg-[oklch(0.73_0.10_75)] hover:text-[oklch(0.18_0.02_270)] flex items-center justify-center transition-colors"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                    <path d="M22 12c0-5.52-4.48-10-10-10S2 6.48 2 12c0 4.84 3.44 8.87 8 9.8V15H8v-3h2V9.5C10 7.57 11.57 6 13.5 6H16v3h-2c-.55 0-1 .45-1 1v2h3v3h-3v6.95c5.05-.5 9-4.76 9-9.95z"/>
                  </svg>
                </a>
                <a
                  href="https://instagram.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Instagram"
                  className="w-9 h-9 rounded-full bg-white/5 hover:bg-[oklch(0.73_0.10_75)] hover:text-[oklch(0.18_0.02_270)] flex items-center justify-center transition-colors"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                    <path d="M12 2.163c3.204 0 3.584.012 4.85.07 1.366.062 2.633.326 3.608 1.301.975.975 1.24 2.242 1.301 3.608.058 1.265.07 1.645.07 4.849 0 3.205-.012 3.584-.07 4.85-.062 1.366-.326 2.633-1.301 3.608-.975.975-2.242 1.24-3.608 1.301-1.265.058-1.645.07-4.85.07-3.204 0-3.584-.012-4.849-.07-1.366-.062-2.633-.326-3.608-1.301-.975-.975-1.24-2.242-1.301-3.608C2.175 15.746 2.163 15.367 2.163 12s.012-3.584.07-4.85c.062-1.366.326-2.633 1.301-3.608C4.51 2.567 5.777 2.302 7.143 2.24 8.408 2.175 8.788 2.163 12 2.163zm0 1.802c-3.141 0-3.5.012-4.75.069-1.148.052-1.77.243-2.184.403a3.64 3.64 0 00-1.32.858c-.414.414-.668.808-.858 1.32-.16.414-.35 1.036-.403 2.184-.057 1.25-.069 1.61-.069 4.75s.012 3.5.069 4.75c.052 1.148.243 1.77.403 2.184.19.512.444.906.858 1.32.414.414.808.668 1.32.858.414.16 1.036.35 2.184.403 1.25.057 1.61.069 4.75.069s3.5-.012 4.75-.069c1.148-.052 1.77-.243 2.184-.403a3.64 3.64 0 001.32-.858c.414-.414.668-.808.858-1.32.16-.414.35-1.036.403-2.184.057-1.25.069-1.61.069-4.75s-.012-3.5-.069-4.75c-.052-1.148-.243-1.77-.403-2.184a3.64 3.64 0 00-.858-1.32 3.64 3.64 0 00-1.32-.858c-.414-.16-1.036-.35-2.184-.403-1.25-.057-1.61-.069-4.75-.069zM12 6.865A5.135 5.135 0 1017.135 12 5.14 5.14 0 0012 6.865zm0 8.468A3.333 3.333 0 1115.333 12 3.337 3.337 0 0112 15.333zm6.538-8.671a1.2 1.2 0 11-1.2-1.2 1.2 1.2 0 011.2 1.2z"/>
                  </svg>
                </a>
              </div>
            </div>
          </div>
        </div>

        {/* Payment methods */}
        <div className="mt-10 pt-6 border-t border-white/10">
          <h4 className="text-xs font-semibold text-[oklch(0.73_0.10_75)] uppercase tracking-wider mb-3">Приемаме плащания с</h4>
          <div className="flex flex-wrap gap-2">
            {[
              { icon: Wallet, label: "Наложен платеж" },
              { icon: CreditCard, label: "Visa" },
              { icon: CreditCard, label: "Mastercard" },
              { icon: CreditCard, label: "Банков превод" },
            ].map(({ icon: Icon, label }) => (
              <div
                key={label}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-white/5 border border-white/10 text-xs text-[oklch(0.96_0.005_270)]"
              >
                <Icon className="w-3.5 h-3.5 text-[oklch(0.73_0.10_75)]" />
                {label}
              </div>
            ))}
          </div>
        </div>

        {/* Copyright */}
        <div className="mt-8 pt-6 border-t border-white/10 flex flex-col sm:flex-row items-center justify-between gap-2 text-sm text-[oklch(0.50_0.02_270)]">
          <p>© {new Date().getFullYear()} Duda 1 ЕООД. Всички права запазени.</p>
          <p>Цените са в EUR с ДДС.</p>
        </div>
      </div>
    </footer>
  );
}
