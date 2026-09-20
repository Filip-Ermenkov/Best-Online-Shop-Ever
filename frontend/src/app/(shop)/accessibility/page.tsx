import type { Metadata } from "next";

/**
 * Accessibility statement.
 *
 * Required of e-commerce service providers under the European Accessibility
 * Act (Directive (EU) 2019/882), Annex V — "Information on services meeting
 * the accessibility requirements." The EAA has been enforceable since
 * 28 June 2025; the harmonised technical standard is EN 301 549, which maps to
 * WCAG (2.1 AA today, 2.2 AA in the V4.x revision). This shop targets WCAG 2.2
 * AA, a superset of 2.1 AA, so the statement is written against 2.2 AA.
 *
 * Annex V asks the statement to cover: a general description of the service in
 * an accessible format; the conformance status; how the relevant accessibility
 * requirements are met; the known limitations; and a feedback + enforcement
 * channel. Mirrors the bilingual (Bulgarian-primary, English-secondary) layout
 * of the /security VDP page so the two legal pages read consistently.
 *
 * Static server component, no client interactivity, no auth. Cache-friendly.
 */
export const metadata: Metadata = {
  title: "Декларация за достъпност | Accessibility Statement — Duda 1",
  description:
    "Декларация за достъпност съгласно Европейския акт за достъпност (Директива (ЕС) 2019/882), " +
    "EN 301 549 и WCAG 2.2 ниво AA. Accessibility statement under the European Accessibility Act.",
};

const LAST_UPDATED = "2 юни 2026 г.";

export default function AccessibilityStatementPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-10 prose prose-sm">
      {/* ─────────────── Bulgarian (primary) ─────────────── */}
      <h1>Декларация за достъпност</h1>
      <p className="text-muted-foreground text-sm">
        Последна актуализация: {LAST_UPDATED} · Версия 1.0
      </p>

      <p>
        Duda 1 ЕООД се ангажира да направи онлайн магазина duda1.shop достъпен за
        възможно най-широк кръг хора, включително хора с увреждания, в
        съответствие с{" "}
        <strong>Европейския акт за достъпност</strong> (Директива (ЕС)
        2019/882, приложима от 28 юни 2025 г.) и хармонизирания европейски
        стандарт <strong>EN&nbsp;301&nbsp;549</strong>.
      </p>

      <h2>Стандарт за съответствие</h2>
      <p>
        Този сайт цели съответствие с{" "}
        <strong>Насоките за достъпност на уеб съдържание (WCAG) 2.2, ниво AA</strong>
        — надмножество на WCAG 2.1 AA, към което препраща EN 301 549. Към
        датата на тази декларация сайтът е{" "}
        <strong>частично съответстващ</strong>: основните потребителски пътеки
        (разглеждане, търсене, количка, поръчка, вход и управление на акаунта)
        отговарят на ниво AA, а известните изключения са изброени по-долу.
      </p>

      <h2>Как тестваме достъпността</h2>
      <p>
        Достъпността не е еднократна проверка, а постоянен процес на няколко
        нива:
      </p>
      <ul>
        <li>
          <strong>Автоматичен статичен анализ</strong> — правилата на{" "}
          <code>eslint-plugin-jsx-a11y</code> се изпълняват при всяко
          подаване на код (CI), така че структурни проблеми се хващат преди
          сливане.
        </li>
        <li>
          <strong>Автоматичен анализ по време на изпълнение</strong> —{" "}
          <code>axe-core</code> чрез Playwright сканира реално визуализираните
          страници за контраст, ARIA и ред на фокуса.
        </li>
        <li>
          <strong>Ръчни проверки</strong> — преминаване само с клавиатура и с
          екранен четец по контролния списък в нашата вътрешна документация.
          Автоматичните инструменти откриват само около 30–40% от проблемите,
          затова ръчните проверки остават задължителни.
        </li>
      </ul>

      <h2>Какво вече е налично</h2>
      <ul>
        <li>Пълна навигация с клавиатура и видим индикатор за фокус на всеки активен елемент.</li>
        <li>
          Връзка „Прескочи към съдържанието“ в началото на всяка страница (WCAG
          2.4.1).
        </li>
        <li>
          Цветови контраст на текста ≥ 4.5:1 (и ≥ 3:1 за едър текст и елементи
          на интерфейса), проверен изчислително.
        </li>
        <li>
          Зачитане на системната настройка „намалено движение“ — анимациите се
          спират при{" "}
          <code>prefers-reduced-motion</code>.
        </li>
        <li>
          Семантичен HTML и ARIA: полето за търсене е същински{" "}
          <em>combobox</em> със стрелки/Enter/Escape; етикети, свързани с всяко
          поле във формуляр; съобщенията за грешка се обявяват от екранни
          четци (<code>{'role="alert"'}</code>).
        </li>
        <li>Езикът на страницата е обявен (<code>{'lang="bg"'}</code>).</li>
      </ul>

      <h2>Известни ограничения</h2>
      <p>
        Стремим се към пълно съответствие, но към момента са известни следните
        ограничения, които работим да отстраним:
      </p>
      <ul>
        <li>
          <strong>Менюто за категории</strong> все още не използва пълния
          клавиатурен модел „menubar“ (придвижване със стрелки между
          елементите). Всички категории остават напълно достъпни с клавиатура:
          през панела „Всички категории“ и чрез под-менютата, които вече се
          отварят както при посочване с мишка, така и при фокус с клавиатура.
        </li>
        <li>
          <strong>Административният панел</strong> е извън обхвата на тази
          декларация (използва се само от оператора, не от клиенти) и все още
          не е преминал пълен одит за достъпност.
        </li>
        <li>
          Съдържание от трети страни (карти на куриерски офиси, когато бъдат
          интегрирани) ще бъде проверено отделно при добавянето му.
        </li>
      </ul>

      <h2>Обратна връзка</h2>
      <p>
        Ако срещнете пречка за достъпност на този сайт или имате нужда от
        съдържание в алтернативен формат, моля пишете ни на{" "}
        <a href="mailto:accessibility@duda1.shop">accessibility@duda1.shop</a>.
        Стремим се да отговорим в рамките на <strong>5 работни дни</strong>.
        Опишете страницата (URL), проблема и — ако желаете — използваната от
        Вас помощна технология, за да можем да възпроизведем случая.
      </p>

      <h2>Защита на правата (ескалация)</h2>
      <p>
        Ако не сте удовлетворени от отговора ни, можете да подадете сигнал до{" "}
        <strong>Комисията за защита на потребителите</strong> — органът по
        прилагане на Европейския акт за достъпност в Република България.
      </p>

      <hr />

      {/* ─────────────── English (secondary) ─────────────── */}
      <h1 id="en">Accessibility Statement</h1>
      <p className="text-muted-foreground text-sm">
        Last updated: 2 June 2026 · Version 1.0
      </p>

      <p>
        Duda 1 ЕООД is committed to making the online shop at duda1.shop
        accessible to the widest possible audience, including people with
        disabilities, in line with the{" "}
        <strong>European Accessibility Act</strong> (Directive (EU) 2019/882,
        applicable since 28 June 2025) and the harmonised European standard{" "}
        <strong>EN&nbsp;301&nbsp;549</strong>.
      </p>

      <h2>Conformance status</h2>
      <p>
        This site targets the{" "}
        <strong>Web Content Accessibility Guidelines (WCAG) 2.2, Level AA</strong>
        — a superset of WCAG 2.1 AA, which EN 301 549 references. As of the date
        of this statement the site is <strong>partially conformant</strong>: the
        core customer journeys (browse, search, cart, checkout, sign-in and
        account management) meet Level AA, with the known exceptions listed
        below.
      </p>

      <h2>How we test accessibility</h2>
      <p>Accessibility is a continuous process across several layers:</p>
      <ul>
        <li>
          <strong>Automated static analysis</strong> — <code>eslint-plugin-jsx-a11y</code>{" "}
          rules run on every commit (CI), so structural issues are caught
          before merge.
        </li>
        <li>
          <strong>Automated runtime analysis</strong> — <code>axe-core</code>{" "}
          via Playwright scans the rendered pages for contrast, ARIA and focus
          order.
        </li>
        <li>
          <strong>Manual checks</strong> — keyboard-only and screen-reader
          walkthroughs against an internal checklist. Automated tools find only
          ~30–40% of issues, so manual review remains mandatory.
        </li>
      </ul>

      <h2>What is already in place</h2>
      <ul>
        <li>Full keyboard navigation with a visible focus indicator on every interactive element.</li>
        <li>A “skip to content” link at the start of every page (WCAG 2.4.1).</li>
        <li>Text colour contrast ≥ 4.5:1 (≥ 3:1 for large text and UI components), verified computationally.</li>
        <li>Respect for the OS “reduce motion” setting — animations stop under <code>prefers-reduced-motion</code>.</li>
        <li>
          Semantic HTML and ARIA: the search field is a true combobox with
          arrow/Enter/Escape keys; every form field has an associated label;
          error messages are announced to screen readers (<code>{'role="alert"'}</code>).
        </li>
        <li>The page language is declared (<code>{'lang="bg"'}</code>).</li>
      </ul>

      <h2>Known limitations</h2>
      <ul>
        <li>
          <strong>The category menu</strong> does not yet implement the full
          “menubar” keyboard model (arrow-key traversal between items). Every
          category remains fully reachable by keyboard: via the “All categories”
          panel and through the sub-menus, which now open on keyboard focus as
          well as mouse hover.
        </li>
        <li>
          <strong>The admin panel</strong> is out of scope for this statement
          (operator-only, not customer-facing) and has not yet had a full
          accessibility audit.
        </li>
        <li>
          Third-party content (courier-office maps, once integrated) will be
          assessed separately when added.
        </li>
      </ul>

      <h2>Feedback</h2>
      <p>
        If you hit an accessibility barrier on this site, or need content in an
        alternative format, email{" "}
        <a href="mailto:accessibility@duda1.shop">accessibility@duda1.shop</a>. We
        aim to respond within <strong>5 working days</strong>. Please include
        the page (URL), the problem and — if you wish — the assistive technology
        you were using, so we can reproduce it.
      </p>
      <h2>Enforcement (escalation)</h2>
      <p>
        If you are not satisfied with our response, you may contact the{" "}
        <strong>Bulgarian Commission for Consumer Protection</strong> (Комисия
        за защита на потребителите), the body responsible for enforcing the
        European Accessibility Act in Bulgaria.
      </p>
    </div>
  );
}
