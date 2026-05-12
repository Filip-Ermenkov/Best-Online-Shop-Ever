import Link from "next/link";

/**
 * /terms/withdrawal — full Bulgarian text of the 14-day right-of-withdrawal
 * policy + the Annex I(B) model withdrawal form (Directive 2011/83/EU).
 *
 * Why a dedicated page (and not a section in /terms):
 *   - Art. 6(1)(h) of the Consumer Rights Directive requires the trader to
 *     provide the "conditions, time limit and procedures for exercising
 *     the right" in a clear and comprehensible manner BEFORE the consumer
 *     is bound. Mixing this into the omnibus T&C page makes the disclosure
 *     harder to find and survive a regulator's "clearly and comprehensibly"
 *     test.
 *   - Art. 8(1) requires the information to be provided in "a way
 *     appropriate to the means of distance communication used" — a
 *     dedicated, linkable URL is the digital-distance equivalent of a
 *     dedicated leaflet.
 *   - The omnibus /terms page is shared with other contractual surfaces
 *     (delivery, pricing, etc.); decoupling withdrawal lets us update
 *     either independently as the legal text evolves.
 *
 * Server component on purpose: this is pure markup with zero interactivity.
 * Indexable, fast, and survives a JS-disabled browser — the directive
 * doesn't require the disclosure to depend on client-side rendering.
 */

export const metadata = {
  title: "14-дневно право на отказ | Условия",
  description:
    "Подробни условия за упражняване на 14-дневното право на отказ по чл. 50 от Закона за защита на потребителите.",
};

export default function WithdrawalTermsPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-10">
      <nav className="text-sm text-muted-foreground mb-6">
        <Link href="/terms" className="hover:text-foreground underline underline-offset-2">
          Условия за ползване
        </Link>
        <span className="mx-2">/</span>
        <span>Право на отказ</span>
      </nav>

      <h1 className="text-3xl font-bold mb-2">
        Информация за 14-дневното право на отказ
      </h1>
      <p className="text-sm text-muted-foreground mb-8">
        Последна актуализация: 12 май 2026 г. По чл. 50 от Закона за защита на
        потребителите (ЗЗП) и Директива 2011/83/ЕС (изменена с Директива
        2023/2673).
      </p>

      <section className="space-y-4 mb-8">
        <h2 className="text-xl font-semibold">Право на отказ</h2>
        <p>
          Имате право да се откажете от настоящия договор без да посочвате
          причина в срок от <strong>14 дни</strong>.
        </p>
        <p>
          Срокът за отказ изтича 14 дни, считано от деня, в който Вие или
          трето лице, различно от превозвача и посочено от Вас, сте получили
          стоката във владение.
        </p>
        <p>
          За да упражните правото си на отказ, трябва да ни уведомите за
          решението си преди изтичането на срока за отказ с недвусмислено
          заявление. Можете да:
        </p>
        <ul className="list-disc pl-6 space-y-1">
          <li>
            <strong>използвате формата „Откажете се от договора тук"</strong>{" "}
            на страницата с детайли на поръчката (намира се в{" "}
            <Link
              href="/account/orders"
              className="underline underline-offset-2 hover:text-foreground"
            >
              История на поръчките
            </Link>
            ) — препоръчителен начин;
          </li>
          <li>
            изпратите попълнен стандартен формуляр за отказ (текстът му е
            публикуван по-долу);
          </li>
          <li>
            направите всяко друго недвусмислено изявление в свободна форма
            (имейл, писмо).
          </li>
        </ul>
        <p>
          За спазване на срока за отказ е достатъчно да изпратите съобщението
          си преди изтичането на 14-дневния срок.
        </p>
      </section>

      <section className="space-y-4 mb-8">
        <h2 className="text-xl font-semibold">Действие на отказа</h2>
        <p>
          В случай че се откажете от настоящия договор, ще Ви възстановим
          всички плащания, получени от Вас, включително разходите за доставка
          (с изключение на допълнителните разходи, свързани с избран от Вас
          начин на доставка, различен от най-евтиния стандартен начин на
          доставка, предлаган от нас).
        </p>
        <p>
          Възстановяването ще бъде извършено без неоправдано забавяне и във
          всички случаи не по-късно от <strong>14 дни</strong> считано от
          датата, на която ни уведомите за решението си за отказ от договора.
        </p>
        <p>
          Ще извършим възстановяването, като използваме същото платежно
          средство, използвано от Вас при първоначалната трансакция, освен ако
          Вие изрично не сте се съгласили на друг начин. Във всеки случай това
          възстановяване няма да бъде свързано с никакви разходи за Вас.
        </p>
        <p>
          Имаме правото да отложим възстановяването на плащанията до получаване
          на стоките обратно или до получаване на доказателство, че сте
          изпратили стоките обратно — в зависимост от това, кое от двете
          събития настъпи по-рано.
        </p>
      </section>

      <section className="space-y-4 mb-8">
        <h2 className="text-xl font-semibold">Връщане на стоката</h2>
        <p>
          Очакваме да върнете стоките без неоправдано забавяне и не по-късно
          от 14 дни след деня, в който сте ни информирали за отказа от
          договора. Срокът се счита за спазен, ако ни изпратите стоките преди
          изтичането на 14-дневния срок.
        </p>
        <p>
          Преките разходи по връщането на стоките са за Ваша сметка, освен ако
          не сме се съгласили да ги поемем.
        </p>
        <p>
          Вие отговаряте единствено за намаляването на стойността на стоките,
          вследствие на изпробването им, различно от необходимото за
          установяване на тяхното естество, характеристики и добро
          функциониране.
        </p>
      </section>

      <section className="space-y-4 mb-8">
        <h2 className="text-xl font-semibold">Изключения</h2>
        <p>
          Правото на отказ не се прилага за следните доставки (чл. 57 от ЗЗП):
        </p>
        <ul className="list-disc pl-6 space-y-1">
          <li>
            стоки, изработени по поръчка на потребителя или съобразно неговите
            индивидуални изисквания;
          </li>
          <li>
            стоки, които поради своето естество могат да влошат качеството си
            или имат кратък срок на годност;
          </li>
          <li>
            запечатани стоки, които са разпечатани след доставката им и не
            могат да бъдат върнати поради съображения, свързани с хигиената
            или защита на здравето;
          </li>
          <li>
            доставка на запечатани звукозаписи или видеозаписи или запечатан
            компютърен софтуер, които са разпечатани след доставката.
          </li>
        </ul>
      </section>

      <section className="mb-10">
        <h2 className="text-xl font-semibold mb-3">
          Стандартен формуляр за отказ
        </h2>
        <p className="text-sm text-muted-foreground mb-4">
          Приложение № 6 към чл. 47, ал. 1, т. 8 от ЗЗП. Попълнете и изпратете
          този формуляр единствено ако желаете да се откажете от договора. По-
          лесният начин е чрез бутона на страницата на поръчката Ви.
        </p>
        <div className="rounded-lg border border-border bg-muted/30 p-5 text-sm space-y-3 leading-relaxed">
          <p>
            <strong>До:</strong> Duda 1 EOOD, contact@duda1.bg
          </p>
          <p>
            С настоящото уведомявам / уведомяваме*, че се отказвам / отказваме*
            от сключения от мен / от нас* договор за покупка на следните
            стоки* / за предоставяне на следната услуга*:
          </p>
          <p className="text-muted-foreground italic">
            [Опишете стоките / услугата]
          </p>
          <p>Поръчано на* / получено на*:</p>
          <p className="text-muted-foreground italic">[Дата]</p>
          <p>Име на потребителя / потребителите:</p>
          <p className="text-muted-foreground italic">[Име]</p>
          <p>Адрес на потребителя / потребителите:</p>
          <p className="text-muted-foreground italic">[Адрес]</p>
          <p>
            Подпис на потребителя / потребителите (само в случай, че настоящият
            формуляр е на хартия):
          </p>
          <p>Дата: <span className="text-muted-foreground italic">[Дата]</span></p>
          <p className="text-xs text-muted-foreground pt-3 border-t border-border">
            * Ненужното се зачерква.
          </p>
        </div>
      </section>

      <section className="space-y-4 mb-8">
        <h2 className="text-xl font-semibold">Контакт</h2>
        <p>
          Duda 1 EOOD
          <br />
          Имейл:{" "}
          <a
            href="mailto:contact@duda1.bg"
            className="underline underline-offset-2 hover:text-foreground"
          >
            contact@duda1.bg
          </a>
          <br />
          Телефон: +359 2 123 4567
        </p>
      </section>

      <hr className="my-8 border-border" />

      <aside className="rounded-lg border border-border bg-muted/30 p-4 text-sm">
        <p className="font-medium mb-1">Готови сте да упражните правото си?</p>
        <p className="text-muted-foreground">
          Влезте в{" "}
          <Link
            href="/account/orders"
            className="underline underline-offset-2 hover:text-foreground"
          >
            История на поръчките
          </Link>{" "}
          и отворете поръчката, която желаете да върнете. Натиснете бутона
          „Откажете се от договора тук" и следвайте указанията.
        </p>
      </aside>
    </div>
  );
}
