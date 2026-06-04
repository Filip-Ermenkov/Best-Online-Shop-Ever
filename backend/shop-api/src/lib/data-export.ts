import { renderDataExportedEmail } from "@shop/email";
import { schema } from "@shop/db";
import { z } from "@hono/zod-openapi";
import { asc, count, desc, eq, inArray } from "drizzle-orm";
import type { Logger } from "pino";
import { getDb } from "./db.js";
import { getEmailTransport } from "./emails.js";
import { parseEnv } from "./env.js";
import { deriveSupportEmail } from "./withdrawal.js";

/**
 * Self-service personal-data export — GDPR Art. 15 (right of access) AND
 * Art. 20 (right to data portability) in one artefact.
 *
 * Design rationale:
 *
 *   - **One file serves both rights.** Art. 20 obliges us to hand over the
 *     data the subject *provided* in a "structured, commonly used and
 *     machine-readable format" (Recital 68 / WP29 guidance → JSON is the
 *     canonical answer). Art. 15 is broader: a *copy* of the data plus the
 *     transparency metadata (purposes, categories, recipients, retention,
 *     the catalogue of rights, the supervisory authority, the existence of
 *     automated decision-making). We satisfy both by shipping the data
 *     sections (Art. 20 portable payload) alongside a `processingInformation`
 *     block (the Art. 15 metadata). Producing both in one self-service
 *     download is the cheapest way to keep us inside the one-month statutory
 *     response window (Art. 12(3)) — it is instantaneous.
 *
 *   - **Identity is verified by re-auth, not by a token.** The route gates
 *     this behind `requireAuth` + a constant-time current-password check
 *     (same posture as change-password / delete-account / email-change).
 *     That is the "verify the requesting individual's identity" step every
 *     DSAR playbook calls for, and it blunts the stolen-session exfiltration
 *     threat: a hijacked cookie alone cannot pull the bundle.
 *
 *   - **Secrets are never exported.** Password hashes, session tokens,
 *     single-use verification/reset token hashes and 2FA recovery-code
 *     hashes are deliberately excluded — they are credentials, not "personal
 *     data the subject provided", and dumping them would be a security
 *     regression. Per-attempt login telemetry (IP/UA of every login attempt)
 *     is also excluded: rows are keyed by email and may contain a third
 *     party's data (an attacker guessing the victim's address), so we ship a
 *     `securityActivity` summary instead of the raw rows. Both exclusions are
 *     disclosed in `processingInformation.dataNotIncluded` so the access
 *     right stays transparent about what was withheld and why.
 *
 *   - **Machine-readable shape.** Timestamps are ISO-8601 strings; money is
 *     integer cents (numbers); field keys are English (interoperable). The
 *     human-facing transparency strings are Bulgarian — the data subject's
 *     language — per Art. 12's "intelligible" requirement.
 */

// ─── Export envelope schema (Zod → OpenAPI component + inferred DTO) ────────

const ExportProfileSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("personal"),
    fullName: z.string(),
    phone: z.string(),
    updatedAt: z.string(),
  }),
  z.object({
    kind: z.literal("corporate"),
    companyName: z.string(),
    eik: z.string(),
    vatNumber: z.string().nullable(),
    registeredAddress: z.string(),
    mol: z.string(),
    contactName: z.string(),
    contactPhone: z.string(),
    updatedAt: z.string(),
  }),
]);

const ExportAddressSchema = z.object({
  id: z.string().uuid(),
  label: z.string().nullable(),
  city: z.string(),
  postalCode: z.string(),
  street: z.string(),
  apartmentOrOffice: z.string().nullable(),
  createdAt: z.string(),
  deletedAt: z.string().nullable(),
});

const ExportCartItemSchema = z.object({
  productId: z.string().uuid(),
  productName: z.string(),
  productSlug: z.string(),
  quantity: z.number().int(),
  addedAt: z.string(),
});

const ExportOrderItemSchema = z.object({
  productCode: z.string(),
  productName: z.string(),
  unitPriceCents: z.number().int(),
  quantity: z.number().int(),
  discountAmountCents: z.number().int(),
});

const ExportOrderSchema = z.object({
  orderNumber: z.string(),
  status: z.string(),
  paymentMethod: z.string(),
  customerEmail: z.string(),
  customerName: z.string(),
  customerPhone: z.string(),
  subtotalCents: z.number().int(),
  discountPercent: z.number(),
  discountAmountCents: z.number().int(),
  totalCents: z.number().int(),
  courierCompany: z.string().nullable(),
  trackingNumber: z.string().nullable(),
  pickupDeadline: z.string().nullable(),
  notes: z.string().nullable(),
  cancelledReason: z.string().nullable(),
  createdAt: z.string(),
  acceptedAt: z.string().nullable(),
  items: z.array(ExportOrderItemSchema),
  deliveryAddress: z
    .object({
      city: z.string(),
      postalCode: z.string(),
      street: z.string(),
      apartmentOrOffice: z.string().nullable(),
    })
    .nullable(),
  corporateData: z
    .object({
      companyName: z.string(),
      eik: z.string(),
      vatNumber: z.string().nullable(),
      registeredAddress: z.string(),
      mol: z.string(),
      contactName: z.string(),
    })
    .nullable(),
  statusHistory: z.array(
    z.object({
      status: z.string(),
      note: z.string().nullable(),
      changedAt: z.string(),
    }),
  ),
  withdrawals: z.array(
    z.object({
      reason: z.string(),
      description: z.string().nullable(),
      submittedAt: z.string(),
      acknowledgedAt: z.string().nullable(),
    }),
  ),
});

/**
 * One cookie-consent receipt as exported. Browser-scoped: keyed to the opaque
 * visitor cookie rather than the account (the `cookie_consents` table is
 * deliberately account-agnostic), so only the receipts for the browser that
 * requested the export are included — see the builder + the visitor-scoping
 * note in `processingInformation`.
 */
const ExportCookieConsentSchema = z.object({
  id: z.string().uuid(),
  acceptedCategories: z.array(z.string()),
  recordedAt: z.string(),
});

export const DataExportSchema = z
  .object({
    export: z.object({
      schemaVersion: z.string(),
      generatedAt: z.string(),
      format: z.literal("application/json"),
      legalBasis: z.array(z.string()),
      description: z.string(),
    }),
    controller: z.object({
      name: z.string(),
      contactEmail: z.string(),
    }),
    account: z.object({
      id: z.string().uuid(),
      email: z.string(),
      role: z.string(),
      accountType: z.string().nullable(),
      emailVerifiedAt: z.string().nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
      deletedAt: z.string().nullable(),
    }),
    profile: ExportProfileSchema.nullable(),
    addresses: z.array(ExportAddressSchema),
    cart: z.object({
      updatedAt: z.string().nullable(),
      items: z.array(ExportCartItemSchema),
    }),
    orders: z.array(ExportOrderSchema),
    accountDiscount: z
      .object({
        percent: z.number(),
        appliedAt: z.string(),
      })
      .nullable(),
    cookieConsents: z.array(ExportCookieConsentSchema),
    securityActivity: z.object({
      recordedLoginAttempts: z.number().int(),
      lastAttemptAt: z.string().nullable(),
    }),
    processingInformation: z.object({
      purposes: z.array(z.string()),
      dataCategories: z.array(z.string()),
      recipientCategories: z.array(z.string()),
      retention: z.array(z.string()),
      rights: z.array(z.string()),
      supervisoryAuthority: z.object({
        name: z.string(),
        website: z.string(),
      }),
      automatedDecisionMaking: z.string(),
      dataNotIncluded: z.array(z.string()),
    }),
  })
  .openapi("DataExport");

export type DataExport = z.infer<typeof DataExportSchema>;

// ─── Helpers ────────────────────────────────────────────────────────────────

const iso = (d: Date | null | undefined): string | null =>
  d ? d.toISOString() : null;
const isoReq = (d: Date): string => d.toISOString();
/** numeric(…) columns come back as strings from pg; parse to a JS number. */
const cents = (v: string | number): number => Number(v);

/**
 * The static Art. 15 transparency block. Field KEYS are English (machine-
 * readable / interoperable); VALUES are Bulgarian — the data subject's
 * language — per Art. 12 ("concise, transparent, intelligible"). Recipient
 * categories rather than named recipients are listed, which Art. 15(1)(c)
 * permits; they describe the data flows the shop is designed around and
 * apply when the relevant feature is used.
 */
function processingInformation(): DataExport["processingInformation"] {
  return {
    purposes: [
      "Изпълнение на договор за продажба и доставка на поръчки (чл. 6, ал. 1, б. „б“ от ОРЗД).",
      "Създаване и управление на потребителски акаунт и удостоверяване (чл. 6, ал. 1, б. „б“).",
      "Спазване на законови задължения — счетоводна и данъчна отчетност (чл. 6, ал. 1, б. „в“; Закон за счетоводството).",
      "Сигурност на акаунта и предотвратяване на злоупотреби (чл. 6, ал. 1, б. „е“ — легитимен интерес).",
    ],
    dataCategories: [
      "Данни за акаунт и удостоверяване: имейл, роля, тип на акаунта, статус на верификация на имейла.",
      "Профилни данни: име и телефон (за физически лица) или фирмени данни (за корпоративни акаунти).",
      "Адреси за доставка от адресния указател.",
      "Съдържание на количката за пазаруване.",
      "Поръчки и история на поръчките, включително фактурни данни и моментни снимки на артикулите.",
      "Записи за отказ от договор (право на отказ в 14-дневен срок).",
      "Телеметрия за сигурност (опити за вход) — предоставена в обобщен вид.",
      "Записи за съгласие за бисквитки (избрани категории, час и IP адрес), обвързани с конкретния браузър чрез анонимен идентификатор.",
    ],
    recipientCategories: [
      "Доставчик на имейл услуга за транзакционни известия (Amazon SES, регион в ЕС).",
      "Куриерски партньори — само за изпълнение на доставката на конкретна поръчка.",
      "Доставчик на хостинг/облачна инфраструктура, действащ като обработващ данните от името на администратора (регион eu-central-1).",
    ],
    retention: [
      "Данни за акаунт и профил: до изтриване на акаунта по Ваше искане (чл. 17).",
      "Поръчки и фактурни данни: 10 години съгласно Закона за счетоводството (запазват се на основание чл. 17, ал. 3, б. „б“ от ОРЗД).",
      "Записи за отказ от договор: за законоустановения срок на съхранение.",
      "Опити за вход: 180 дни.",
      "Количка: докато не я изпразните или изтриете акаунта си.",
      "Записи за съгласие за бисквитки: до оттегляне или подмяна на съгласието и за разумен период след това за целите на доказване.",
    ],
    rights: [
      "Право на достъп (чл. 15) — настоящият експорт.",
      "Право на преносимост на данните (чл. 20) — настоящият експорт е в структуриран, машинно четим формат (JSON).",
      "Право на коригиране (чл. 16) — чрез страницата на профила Ви.",
      "Право на изтриване / „право да бъдеш забравен“ (чл. 17) — чрез страницата за изтриване на акаунт.",
      "Право на ограничаване на обработването и право на възражение (чл. 18 и чл. 21).",
      "Право на жалба до надзорен орган (чл. 77).",
    ],
    supervisoryAuthority: {
      name: "Комисия за защита на личните данни (КЗЛД)",
      website: "https://www.cpdp.bg",
    },
    automatedDecisionMaking:
      "Не се извършва автоматизирано вземане на решения, включително профилиране, по смисъла на чл. 22 от ОРЗД.",
    dataNotIncluded: [
      "Пароли — съхраняват се само като Argon2id хешове и са технически невъзстановими.",
      "Токени за сесии и еднократни токени (верификация на имейл, нулиране на парола) — секрети, чието разкриване би било риск за сигурността.",
      "Кодове за двуфакторно възстановяване — съхраняват се само като хешове.",
      "Подробни записи на отделните опити за вход (IP адреси, потребителски агенти) — поради риск за сигурността и възможно съдържание на данни на трети лица; вместо това в раздел „securityActivity“ е включено обобщение.",
      "Записи за съгласие за бисквитки от други браузъри или устройства — съгласието е обвързано с конкретен браузър чрез анонимен идентификатор и не може със сигурност да бъде свързано с акаунта; включени са само записите за браузъра, от който е заявен експортът.",
    ],
  };
}

// ─── The builder ────────────────────────────────────────────────────────────

/**
 * Assemble the full export for a user. The caller (the route) has already
 * verified the session AND the current password, so the user row is expected
 * to exist; we still throw a typed sentinel if it has vanished mid-request so
 * the route can map it to a clean 401 rather than a 500.
 */
export class ExportUserMissingError extends Error {
  constructor() {
    super("User row missing while building data export.");
    this.name = "ExportUserMissingError";
  }
}

export async function buildUserDataExport(
  userId: string,
  opts?: { visitorId?: string | null },
): Promise<DataExport> {
  const db = getDb();
  const env = parseEnv();

  // ── Account ──────────────────────────────────────────────────────────────
  const [user] = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      role: schema.users.role,
      accountType: schema.users.accountType,
      emailVerifiedAt: schema.users.emailVerifiedAt,
      createdAt: schema.users.createdAt,
      updatedAt: schema.users.updatedAt,
      deletedAt: schema.users.deletedAt,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (!user) throw new ExportUserMissingError();

  // ── Profile (personal | corporate | none) ────────────────────────────────
  let profile: DataExport["profile"] = null;
  const [personal] = await db
    .select()
    .from(schema.customerProfiles)
    .where(eq(schema.customerProfiles.userId, userId))
    .limit(1);
  if (personal) {
    profile = {
      kind: "personal",
      fullName: personal.fullName,
      phone: personal.phone,
      updatedAt: isoReq(personal.updatedAt),
    };
  } else {
    const [corp] = await db
      .select()
      .from(schema.corporateProfiles)
      .where(eq(schema.corporateProfiles.userId, userId))
      .limit(1);
    if (corp) {
      profile = {
        kind: "corporate",
        companyName: corp.companyName,
        eik: corp.eik,
        vatNumber: corp.vatNumber ?? null,
        registeredAddress: corp.registeredAddress,
        mol: corp.mol,
        contactName: corp.contactName,
        contactPhone: corp.contactPhone,
        updatedAt: isoReq(corp.updatedAt),
      };
    }
  }

  // ── Address book ──────────────────────────────────────────────────────────
  const addressRows = await db
    .select()
    .from(schema.addresses)
    .where(eq(schema.addresses.userId, userId))
    .orderBy(asc(schema.addresses.createdAt));
  const addresses: DataExport["addresses"] = addressRows.map((a) => ({
    id: a.id,
    label: a.label ?? null,
    city: a.city,
    postalCode: a.postalCode,
    street: a.street,
    apartmentOrOffice: a.apartmentOrOffice ?? null,
    createdAt: isoReq(a.createdAt),
    deletedAt: iso(a.deletedAt),
  }));

  // ── Cart ───────────────────────────────────────────────────────────────────
  const [cartRow] = await db
    .select()
    .from(schema.carts)
    .where(eq(schema.carts.userId, userId))
    .limit(1);
  const cartItemRows = await db
    .select({
      productId: schema.cartItems.productId,
      quantity: schema.cartItems.quantity,
      addedAt: schema.cartItems.addedAt,
      productName: schema.products.name,
      productSlug: schema.products.slug,
    })
    .from(schema.cartItems)
    .innerJoin(schema.products, eq(schema.products.id, schema.cartItems.productId))
    .where(eq(schema.cartItems.cartUserId, userId))
    .orderBy(asc(schema.cartItems.addedAt));
  const cart: DataExport["cart"] = {
    updatedAt: cartRow ? isoReq(cartRow.updatedAt) : null,
    items: cartItemRows.map((ci) => ({
      productId: ci.productId,
      productName: ci.productName,
      productSlug: ci.productSlug,
      quantity: ci.quantity,
      addedAt: isoReq(ci.addedAt),
    })),
  };

  // ── Orders (+ children, batched to avoid N+1) ─────────────────────────────
  const orderRows = await db
    .select()
    .from(schema.orders)
    .where(eq(schema.orders.customerId, userId))
    .orderBy(asc(schema.orders.createdAt));
  const orderIds = orderRows.map((o) => o.id);

  const itemRows = orderIds.length
    ? await db
        .select()
        .from(schema.orderItems)
        .where(inArray(schema.orderItems.orderId, orderIds))
    : [];
  const deliveryRows = orderIds.length
    ? await db
        .select()
        .from(schema.orderDeliveryAddress)
        .where(inArray(schema.orderDeliveryAddress.orderId, orderIds))
    : [];
  const corporateRows = orderIds.length
    ? await db
        .select()
        .from(schema.orderCorporateData)
        .where(inArray(schema.orderCorporateData.orderId, orderIds))
    : [];
  const historyRows = orderIds.length
    ? await db
        .select()
        .from(schema.orderStatusHistory)
        .where(inArray(schema.orderStatusHistory.orderId, orderIds))
        .orderBy(asc(schema.orderStatusHistory.changedAt))
    : [];
  const complaintRows = orderIds.length
    ? await db
        .select()
        .from(schema.complaints)
        .where(inArray(schema.complaints.orderId, orderIds))
        .orderBy(asc(schema.complaints.submittedAt))
    : [];

  const orders: DataExport["orders"] = orderRows.map((o) => {
    const delivery = deliveryRows.find((d) => d.orderId === o.id) ?? null;
    const corp = corporateRows.find((d) => d.orderId === o.id) ?? null;
    return {
      orderNumber: o.orderNumber,
      status: o.status,
      paymentMethod: o.paymentMethod,
      customerEmail: o.customerEmail,
      customerName: o.customerName,
      customerPhone: o.customerPhone,
      subtotalCents: cents(o.subtotalCents),
      discountPercent: cents(o.discountPercent),
      discountAmountCents: cents(o.discountAmountCents),
      totalCents: cents(o.totalCents),
      courierCompany: o.courierCompany ?? null,
      trackingNumber: o.trackingNumber ?? null,
      pickupDeadline: iso(o.pickupDeadline),
      notes: o.notes ?? null,
      cancelledReason: o.cancelledReason ?? null,
      createdAt: isoReq(o.createdAt),
      acceptedAt: iso(o.acceptedAt),
      items: itemRows
        .filter((it) => it.orderId === o.id)
        .map((it) => ({
          productCode: it.productCode,
          productName: it.productName,
          unitPriceCents: cents(it.unitPriceCents),
          quantity: it.quantity,
          discountAmountCents: cents(it.discountAmountCents),
        })),
      deliveryAddress: delivery
        ? {
            city: delivery.city,
            postalCode: delivery.postalCode,
            street: delivery.street,
            apartmentOrOffice: delivery.apartmentOrOffice ?? null,
          }
        : null,
      corporateData: corp
        ? {
            companyName: corp.companyName,
            eik: corp.eik,
            vatNumber: corp.vatNumber ?? null,
            registeredAddress: corp.registeredAddress,
            mol: corp.mol,
            contactName: corp.contactName,
          }
        : null,
      statusHistory: historyRows
        .filter((h) => h.orderId === o.id)
        .map((h) => ({
          status: h.status,
          note: h.note ?? null,
          changedAt: isoReq(h.changedAt),
        })),
      withdrawals: complaintRows
        .filter((cp) => cp.orderId === o.id && cp.reason === "withdrawal")
        .map((cp) => ({
          reason: cp.reason,
          description: cp.description ?? null,
          submittedAt: isoReq(cp.submittedAt),
          acknowledgedAt: iso(cp.acknowledgedAt),
        })),
    };
  });

  // ── Per-account discount ──────────────────────────────────────────────────
  const [discountRow] = await db
    .select()
    .from(schema.discounts)
    .where(eq(schema.discounts.userId, userId))
    .limit(1);
  const accountDiscount: DataExport["accountDiscount"] = discountRow
    ? { percent: cents(discountRow.percent), appliedAt: isoReq(discountRow.appliedAt) }
    : null;

  // ── Cookie-consent receipts (browser-scoped) ──────────────────────────────
  // Consent is keyed to an opaque visitor cookie, not to the account, so we
  // include the receipts for the browser making THIS export request — those
  // matching the visitor id on the request. That is the set the access right
  // can honestly associate with the requester right now; the visitor-scoping
  // is disclosed in processingInformation. No visitor id on the request (the
  // browser never recorded consent) ⇒ an empty list.
  const cookieConsents: DataExport["cookieConsents"] = opts?.visitorId
    ? (
        await db
          .select()
          .from(schema.cookieConsents)
          .where(eq(schema.cookieConsents.visitorId, opts.visitorId))
          .orderBy(asc(schema.cookieConsents.recordedAt))
      ).map((r) => ({
        id: r.id,
        acceptedCategories: r.acceptedCategories,
        recordedAt: isoReq(r.recordedAt),
      }))
    : [];

  // ── Security activity summary (NOT the raw rows — see file header) ────────
  // login_attempts is keyed by email text (not user_id). Two cheap queries
  // (count + most-recent) rather than an aggregate `max`, so the timestamp
  // comes back typed as a Date (the column type) without depending on how the
  // driver maps an aggregate's return.
  const loginEmail = user.email.toLowerCase();
  const [attemptCount] = await db
    .select({ n: count() })
    .from(schema.loginAttempts)
    .where(eq(schema.loginAttempts.email, loginEmail));
  const [lastAttempt] = await db
    .select({ attemptedAt: schema.loginAttempts.attemptedAt })
    .from(schema.loginAttempts)
    .where(eq(schema.loginAttempts.email, loginEmail))
    .orderBy(desc(schema.loginAttempts.attemptedAt))
    .limit(1);
  const securityActivity: DataExport["securityActivity"] = {
    recordedLoginAttempts: Number(attemptCount?.n ?? 0),
    lastAttemptAt: iso(lastAttempt?.attemptedAt ?? null),
  };

  return {
    export: {
      schemaVersion: "1.1",
      generatedAt: isoReq(new Date()),
      format: "application/json",
      legalBasis: [
        "GDPR Article 15 (right of access)",
        "GDPR Article 20 (right to data portability)",
      ],
      description:
        "Структуриран, машинно четим експорт на личните данни, свързани с Вашия акаунт, " +
        "предоставен в изпълнение на правото Ви на достъп (чл. 15) и правото Ви на " +
        "преносимост на данните (чл. 20) съгласно Общия регламент относно защитата на данните.",
    },
    controller: {
      name: "Best Online Shop",
      contactEmail: deriveSupportEmail(env.EMAIL_FROM),
    },
    account: {
      id: user.id,
      email: user.email,
      role: user.role,
      accountType: user.accountType ?? null,
      emailVerifiedAt: iso(user.emailVerifiedAt),
      createdAt: isoReq(user.createdAt),
      updatedAt: isoReq(user.updatedAt),
      deletedAt: iso(user.deletedAt),
    },
    profile,
    addresses,
    cart,
    orders,
    accountDiscount,
    cookieConsents,
    securityActivity,
    processingInformation: processingInformation(),
  };
}

// ─── Per-user export frequency limit (in-memory) ──────────────────────────────
//
// GDPR Art. 12(5) lets a controller refuse or charge for "manifestly
// unfounded or excessive" requests, "in particular because of their
// repetitive character". A self-service export already requires a fresh
// password each time (that is the real abuse brake), but each successful
// export also fires a notification email — so an attacker who DID know the
// password could otherwise spam the victim's inbox. This sliding-window
// counter caps that.
//
// In-memory, mirroring the CSP-report rate limiter (see lib/csp-report.ts):
// Lambda containers don't share this state, and it resets on a cold start.
// For a single-admin, low-traffic shop that is acceptable; a stricter cap
// (DB- or Redis-backed) is a future hardening if export volume ever warrants
// it. The re-auth requirement remains the primary control regardless.

const EXPORT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const EXPORT_MAX_PER_WINDOW = 5;
/** Soft cap on tracked users to bound memory if this ever sees real volume. */
const MAX_TRACKED_USERS = 10_000;

const exportHits = new Map<string, number[]>();

export interface ExportRateLimitState {
  allowed: boolean;
  /** Milliseconds until the caller may retry. Null when allowed. */
  retryAfterMs: number | null;
}

/**
 * Check-and-record in one call: if under the limit, records this attempt and
 * returns `{ allowed: true }`; otherwise returns `{ allowed: false }` with the
 * time until the oldest hit ages out of the window.
 */
export function checkAndRecordExport(
  userId: string,
  nowMs: number = Date.now(),
): ExportRateLimitState {
  const cutoff = nowMs - EXPORT_WINDOW_MS;
  const hits = (exportHits.get(userId) ?? []).filter((t) => t > cutoff);

  if (hits.length >= EXPORT_MAX_PER_WINDOW) {
    exportHits.set(userId, hits); // persist the pruned list
    const oldest = hits[0] ?? nowMs;
    return { allowed: false, retryAfterMs: Math.max(oldest + EXPORT_WINDOW_MS - nowMs, 0) };
  }

  hits.push(nowMs);
  exportHits.set(userId, hits);

  // Opportunistic memory bound: if the map has grown large, drop entries whose
  // most-recent hit has fully aged out.
  if (exportHits.size > MAX_TRACKED_USERS) {
    for (const [key, ts] of exportHits) {
      const latest = ts[ts.length - 1] ?? 0;
      if (latest <= cutoff) exportHits.delete(key);
    }
  }

  return { allowed: true, retryAfterMs: null };
}

/** Test-only: clear the in-memory counters between tests. */
export function _resetExportRateLimitForTests(): void {
  exportHits.clear();
}

// ─── Best-effort notification email ───────────────────────────────────────────

export interface SendDataExportedNotificationInput {
  to: string;
  fullName?: string | null;
  exportedAt?: Date;
  logger?: Logger;
}

/**
 * Best-effort send of the "your data was exported" notice. Returns true iff
 * the transport accepted the message. Never throws — a failed notification
 * MUST NOT fail the export the user already received over the authenticated
 * channel (identical posture to every other security-event email here).
 */
export async function sendDataExportedNotification(
  input: SendDataExportedNotificationInput,
): Promise<boolean> {
  try {
    const env = parseEnv();
    const transport = getEmailTransport();
    const email = renderDataExportedEmail({
      to: input.to,
      fullName: input.fullName ?? null,
      exportedAt: input.exportedAt ?? new Date(),
      supportEmail: deriveSupportEmail(env.EMAIL_FROM),
    });
    await transport.send(email);
    return true;
  } catch (err) {
    input.logger?.warn({ err }, "data_export_email_failed");
    return false;
  }
}
