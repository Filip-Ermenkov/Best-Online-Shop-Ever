import type { OutgoingEmail } from "../types.js";

/**
 * Unverified-account deletion warning — sent on day 6 by the daily
 * scheduler-fn cleanup job, 24 hours before the account is deleted.
 *
 * Per docs/README.md §8 („Автоматично изтриване на неверифицирани акаунти"):
 * an account whose email is not verified within 7 days of registration is
 * deleted automatically; on day 6 the system sends „Вашият акаунт ще бъде
 * изтрит утре, тъй като имейл адресът не е потвърден. [Потвърди сега] или
 * [Изпрати нов линк]".
 *
 * The primary CTA carries a FRESH verification token (issued by the job —
 * the original one from registration has long expired), so „Потвърди сега"
 * works with one click. The secondary CTA goes to the site, where the
 * signed-in unverified user gets the resend banner.
 *
 * GDPR posture: this email is the storage-limitation courtesy notice. The
 * deletion itself does not depend on it — see the cleanup job's notes.
 */

export interface AccountDeletionWarningTemplateInput {
  to: string;
  /** Display name when the registration captured one; falls back to a neutral greeting. */
  fullName?: string | null;
  /** One-click verification link carrying a freshly issued token. */
  verifyUrl: string;
  /** Where the "send a new link" path lives (the storefront resend banner). */
  resendUrl: string;
  /** Moment after which the account is eligible for deletion (registration + 7 days). */
  deleteAfter: Date;
  shopName?: string;
}

export const ACCOUNT_DELETION_WARNING_TEMPLATE_ID = "auth.account-deletion-warning";

export function renderAccountDeletionWarningEmail(
  input: AccountDeletionWarningTemplateInput,
): OutgoingEmail {
  const shopName = input.shopName ?? "Best Online Shop";
  const greetingName = (input.fullName ?? "").trim();
  const greeting = greetingName.length > 0 ? `Здравейте, ${greetingName},` : "Здравейте,";
  const deleteAfterFormatted = formatSofiaTimestamp(input.deleteAfter);
  const subject = "Вашият акаунт ще бъде изтрит утре — потвърдете имейл адреса си";

  const text = [
    greeting,
    "",
    "Вашият акаунт ще бъде изтрит утре, тъй като имейл адресът не е потвърден.",
    "",
    `Регистрирахте се преди 6 дни, но имейл адресът все още не е потвърден. Съгласно правилата ни за съхранение на данни, непотвърдените акаунти се изтриват автоматично 7 дни след регистрацията (след ${deleteAfterFormatted} ч., Европа/София).`,
    "",
    "Ако искате да запазите акаунта си, потвърдете имейл адреса сега:",
    input.verifyUrl,
    "",
    "Линкът е валиден 24 часа. Ако е изтекъл, можете да заявите нов от сайта:",
    input.resendUrl,
    "",
    "Ако не сте правили тази регистрация или не желаете акаунт, не е нужно да правите нищо — акаунтът и данните ви ще бъдат изтрити автоматично.",
    "",
    `— ${shopName}`,
  ].join("\n");

  const html = `<!doctype html>
<html lang="bg">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f5;">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:8px;border:1px solid #e4e4e7;">
            <tr>
              <td style="padding:24px 32px 8px 32px;">
                <h1 style="margin:0;font-size:18px;font-weight:600;color:#18181b;">Вашият акаунт ще бъде изтрит утре</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 32px 0 32px;font-size:14px;line-height:1.6;color:#27272a;">
                <p style="margin:0 0 12px 0;">${escapeHtml(greeting)}</p>
                <p style="margin:0 0 12px 0;">
                  Регистрирахте се преди 6 дни, но имейл адресът все още не е потвърден.
                  Съгласно правилата ни за съхранение на данни, непотвърдените акаунти се
                  изтриват автоматично 7 дни след регистрацията
                  (след <strong>${escapeHtml(deleteAfterFormatted)}</strong> ч., Европа/София).
                </p>
                <p style="margin:0 0 16px 0;">Ако искате да запазите акаунта си, потвърдете имейл адреса сега:</p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 8px 32px;">
                <a href="${escapeAttr(input.verifyUrl)}" style="display:inline-block;padding:12px 24px;background-color:#18181b;color:#ffffff;border-radius:6px;font-size:14px;font-weight:600;text-decoration:none;">Потвърди сега</a>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 32px 16px 32px;font-size:13px;line-height:1.6;color:#52525b;">
                <p style="margin:0 0 8px 0;">
                  Линкът е валиден 24 часа. Ако е изтекъл,
                  <a href="${escapeAttr(input.resendUrl)}" style="color:#3f3f46;text-decoration:underline;">заявете нов линк от сайта</a>.
                </p>
                <p style="margin:0;">
                  Ако не сте правили тази регистрация или не желаете акаунт, не е нужно да
                  правите нищо — акаунтът и данните ви ще бъдат изтрити автоматично.
                </p>
              </td>
            </tr>
          </table>
          <p style="margin:16px 0 0 0;font-size:12px;color:#a1a1aa;">
            Това съобщение е автоматично известие от ${escapeHtml(shopName)}.
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return {
    to: input.to,
    subject,
    html,
    text,
    templateId: ACCOUNT_DELETION_WARNING_TEMPLATE_ID,
  };
}

function formatSofiaTimestamp(d: Date): string {
  return d.toLocaleString("bg-BG", {
    timeZone: "Europe/Sofia",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
