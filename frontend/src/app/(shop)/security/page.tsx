import type { Metadata } from "next";

/**
 * Vulnerability Disclosure Policy page.
 *
 * This is the page that /.well-known/security.txt's `Policy:` field
 * points to (RFC 9116 §2.5.7). It exists for two audiences:
 *
 * 1. **Security researchers** who want to know: are you a "safe harbor"
 *    company? What's in scope? How fast will you respond?
 * 2. **Compliance auditors** mapping our practice against:
 *    - NIST CSF 2.0 — Govern function (GV.OC, GV.PO, GV.OV)
 *    - OWASP ASVS 6.0 V1.14 (secure software lifecycle)
 *    - EU CRA Annex I, Part II §5 (vulnerability disclosure)
 *    - ISO/IEC 29147:2018 (vulnerability disclosure processes)
 *
 * Content is bilingual: Bulgarian first because the shop is Bulgarian,
 * English second because most international researchers will reach
 * for English. We don't link a translator widget — the two versions
 * are maintained side-by-side so a translation drift doesn't silently
 * change the legal posture.
 *
 * Static page, no client interactivity, no auth. Cache-friendly.
 */
export const metadata: Metadata = {
  title: "Политика за разкриване на уязвимости | Vulnerability Disclosure Policy — Duda 1",
  description:
    "Координирана политика за разкриване на уязвимости съгласно ISO/IEC 29147 и EU CRA. " +
    "Coordinated vulnerability disclosure policy under ISO/IEC 29147 and the EU CRA.",
};

export default function SecurityPolicyPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-10 prose prose-sm">
      {/* ─────────────── Bulgarian (primary) ─────────────── */}
      <h1>Политика за разкриване на уязвимости</h1>
      <p className="text-muted-foreground text-sm">
        Последна актуализация: 17 май 2026 г. · Версия 1.0
      </p>

      <p>
        Благодарим, че помагате да поддържаме нашите клиенти и техните данни в
        безопасност. Тази страница описва как да докладвате уязвимост в системите
        на Duda 1 ЕООД (онлайн магазин duda1.bg) и какво да очаквате от нас в
        отговор.
      </p>

      <h2>Как да докладвате</h2>
      <p>
        Изпратете писмо на{" "}
        <a href="mailto:security@duda1.bg">security@duda1.bg</a>. Включете:
      </p>
      <ul>
        <li>Описание на уязвимостта и потенциалното ѝ въздействие.</li>
        <li>Стъпки за възпроизвеждане (URL, payload, screenshot или PoC).</li>
        <li>Вашите данни за контакт, ако желаете отговор.</li>
      </ul>
      <p>
        Можете да докладвате анонимно. Криптирано съобщение е по желание —
        пишете ни и ще обменим публичен PGP ключ извън канала.
      </p>

      <h2>Какво ще направим ние</h2>
      <ul>
        <li>
          <strong>В рамките на 72 часа</strong> — потвърждаваме получаването.
        </li>
        <li>
          <strong>В рамките на 14 дни</strong> — даваме първоначална оценка
          (валидна / невалидна / дубликат) и срок за корекция.
        </li>
        <li>
          <strong>В рамките на 90 дни</strong> — публикуваме корекция за
          валидните уязвимости. По-сложни случаи могат да отнемат повече, но
          ще ви държим в течение.
        </li>
        <li>
          С ваше съгласие ще ви признаем за откривател в нашия changelog.
        </li>
      </ul>

      <h2>Какво очакваме от вас (safe harbor)</h2>
      <p>
        Няма да предприемем правни действия срещу изследователи, които
        добросъвестно спазват тази политика. Това включва изключения от
        Закона за киберсигурност и сходни закони за добросъвестно тестване.
        За да се квалифицирате, моля:
      </p>
      <ul>
        <li>Тествайте само срещу свои собствени акаунти, не на чужди.</li>
        <li>
          Не изтегляйте, копирайте или съхранявайте данни на потребители
          (имена, телефони, адреси, поръчки). Ако случайно получите достъп —
          незабавно прекратете и докладвайте.
        </li>
        <li>
          Не правете DoS, не изпращайте спам, не правете social engineering
          срещу служители или клиенти.
        </li>
        <li>
          Не публикувайте уязвимостта преди ние да издадем корекция или
          преди 90-те дни да изтекат (което настъпи по-рано).
        </li>
      </ul>

      <h2>Обхват</h2>
      <p>
        <strong>В обхвата</strong> са следните производствени системи:
      </p>
      <ul>
        <li>
          <code>duda1.bg</code> и поддомейни (<code>shop-api.duda1.bg</code>,{" "}
          <code>admin.duda1.bg</code>)
        </li>
        <li>Мобилни приложения, ако и когато бъдат пуснати.</li>
        <li>Имейл инфраструктура (SPF, DKIM, DMARC конфигурации).</li>
      </ul>
      <p>
        <strong>Извън обхвата:</strong> атаки срещу инфраструктурата на
        нашите доставчици (AWS, Neon, Cloudflare); rate-limiting bypasses
        без съществено въздействие; самозвани „best-practice“ препоръки без
        реален експлойт; clickjacking на страници без чувствителни действия;
        липсваща HTTP сигурностна заглавка без демонстриран експлойт.
      </p>

      <h2>Награди</h2>
      <p>
        Към май 2026 г. не предлагаме парични награди (bug bounty). Това
        може да се промени. Признаваме всеки добросъвестен изследовател
        публично, ако пожелае.
      </p>

      <h2>Регулаторна основа</h2>
      <p>
        Тази политика е съвместима с ISO/IEC 29147:2018 (координирано
        разкриване на уязвимости) и подготвена за изискванията на ЕС Закон
        за киберустойчивост (Cyber Resilience Act), Анекс I, Част II, точка
        5 — задължителен срок за докладване от 11 септември 2026 г. Машинно
        четимият контакт е публикуван съгласно RFC 9116 на{" "}
        <a href="/.well-known/security.txt" className="font-mono">
          /.well-known/security.txt
        </a>
        .
      </p>

      <hr />

      {/* ─────────────── English (secondary) ─────────────── */}
      <h1 id="en">Vulnerability Disclosure Policy</h1>
      <p className="text-muted-foreground text-sm">
        Last updated: 17 May 2026 · Version 1.0
      </p>

      <p>
        Thank you for helping keep our customers and their data safe. This
        page describes how to report a security vulnerability in any
        system operated by Duda 1 ЕООД (the online shop at duda1.bg) and
        what to expect from us in return.
      </p>

      <h2>How to report</h2>
      <p>
        Email <a href="mailto:security@duda1.bg">security@duda1.bg</a>.
        Include:
      </p>
      <ul>
        <li>A description of the vulnerability and its potential impact.</li>
        <li>
          Reproduction steps (URL, payload, screenshot, or proof-of-concept).
        </li>
        <li>Your contact details, if you'd like a reply.</li>
      </ul>
      <p>
        Anonymous reports are welcome. Encryption is optional — write in and
        we'll exchange a PGP public key out-of-band if you prefer.
      </p>

      <h2>What we'll do</h2>
      <ul>
        <li>
          <strong>Within 72 hours</strong> — we'll acknowledge receipt.
        </li>
        <li>
          <strong>Within 14 days</strong> — we'll triage (valid /
          invalid / duplicate) and give you a remediation timeline.
        </li>
        <li>
          <strong>Within 90 days</strong> — we'll ship a fix for valid
          vulnerabilities. More complex cases may take longer; we'll keep
          you informed.
        </li>
        <li>
          With your consent, we'll credit you as the reporter in our public
          changelog.
        </li>
      </ul>

      <h2>What we expect from you (safe harbor)</h2>
      <p>
        We will not pursue legal action against researchers who act in good
        faith and follow this policy. This includes good-faith exceptions
        to the Bulgarian Cybersecurity Act and equivalent legislation. To
        qualify, please:
      </p>
      <ul>
        <li>Test only against accounts you own.</li>
        <li>
          Don't download, copy, or store customer data (names, phone
          numbers, addresses, orders). If you accidentally access it — stop
          immediately and tell us.
        </li>
        <li>
          No denial-of-service, no spam, no social engineering against staff
          or customers.
        </li>
        <li>
          Don't publish the vulnerability before we've shipped a fix or
          before 90 days have elapsed, whichever comes first.
        </li>
      </ul>

      <h2>Scope</h2>
      <p>
        <strong>In scope:</strong> production systems on{" "}
        <code>duda1.bg</code> and subdomains (<code>shop-api.duda1.bg</code>,{" "}
        <code>admin.duda1.bg</code>), any mobile apps if and when they
        launch, and email infrastructure (SPF, DKIM, DMARC).
      </p>
      <p>
        <strong>Out of scope:</strong> attacks against our suppliers'
        infrastructure (AWS, Neon, Cloudflare); rate-limit bypasses without
        material impact; self-styled "best-practice" recommendations
        without a working exploit; clickjacking on pages without sensitive
        actions; missing HTTP security headers without a demonstrated
        exploit.
      </p>

      <h2>Rewards</h2>
      <p>
        As of May 2026 we do not offer a paid bug bounty. This may change.
        We publicly credit any good-faith researcher who wishes to be
        named.
      </p>

      <h2>Regulatory basis</h2>
      <p>
        This policy is aligned with ISO/IEC 29147:2018 (coordinated
        vulnerability disclosure) and prepared for the EU Cyber Resilience
        Act, Annex I, Part II §5 — mandatory disclosure timelines from
        11 September 2026. The machine-readable contact is published per
        RFC 9116 at{" "}
        <a href="/.well-known/security.txt" className="font-mono">
          /.well-known/security.txt
        </a>
        .
      </p>
    </div>
  );
}
